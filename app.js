'use strict';
/* Registro Visite – Is Mellus. App offline-first: tutto viene salvato sul dispositivo
   e inviato al foglio Google quando c'è connessione (automaticamente o con "Sincronizza"). */

const CONFIG = {
  obbligatori: { esito: true, step: true, follow: true }, // campi obbligatori nella visita
};
const K = { cfg: 'rv_cfg', data: 'rv_data', queue: 'rv_queue' };
const DEF_LISTE = {
  'Tipo visita': ['Visita', 'Call', 'Email/WhatsApp', 'Meeting', 'Food testing', 'Consegna samples', 'Altro'],
  'Tipologia': ['Hotel', 'Ristorante', 'Retail / Market', 'Catering', 'Cloud kitchen', 'Altro'],
  'Canale acquisto': ['Diretto', 'BSS (Birch Street)', 'Distributore', 'Altro'],
  'Priorità': ['Alta', 'Media', 'Bassa'],
  'Feedback samples': ['In attesa', 'Positivo', 'Negativo', 'Da ripetere'],
  'Stato quotazione': ['Inviata', 'Accettata', 'Rifiutata', 'In negoziazione', 'Scaduta'],
};
const FATTO = ['scritta', 'duplicato', 'creato', 'esistente', 'scritto'];

/* ---------- memoria del dispositivo ---------- */
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};
let cfg = store.get(K.cfg, null);
let data = store.get(K.data, null);
let queue = store.get(K.queue, null) || { nuoviClienti: [], visite: [], feedback: [] };
let ui = { sel: null, view: 'welcome', filter: 'all', q: '', okInfo: null, confirmDel: null };
let syncing = false;

function saveQueue() {
  if (store.set(K.queue, queue)) return true;
  flash('err', 'Il dispositivo non riesce a salvare (memoria piena o navigazione privata). Non chiudere l\'app: sincronizza appena possibile.');
  return false;
}
function pendingCount() { return queue.nuoviClienti.length + queue.visite.length + queue.feedback.length; }

/* ---------- utilità ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const key = s => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fmt = d => { if (!d) return ''; const [y, m, g] = String(d).slice(0, 10).split('-'); return g ? `${g}/${m}/${y}` : String(d); };
const fmtTime = iso => { if (!iso) return ''; const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const uid = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const lista = h => (data && data.liste && data.liste[h] && data.liste[h].length) ? data.liste[h] : (DEF_LISTE[h] || []);
const pill = v => `<span class="pill p-${['SI', 'NO', 'BSS'].includes(v) ? v : 'nd'}">${esc(v || 'n.d.')}</span>`;
const opts = (arr, sel) => arr.map(o => `<option${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');
const isLate = c => c.dataProssima && c.dataProssima < today();
function flash(kind, text) {
  $('#flash').innerHTML = text ? `<div class="msg ${kind}" role="status">${text}</div>` : '';
  if (kind === 'ok' || kind === 'info') { const t = text; setTimeout(() => { if ($('#flash').textContent.includes(t.replace(/<[^>]+>/g, '').slice(0, 20))) $('#flash').innerHTML = ''; }, 6000); }
}

/* ---------- vista dei clienti = dati del foglio + modifiche non ancora inviate ---------- */
function clienti() {
  const base = ((data && data.clienti) || []).map(c => ({ ...c, visite: [...(c.visite || [])], samplesAperti: [...(c.samplesAperti || [])], contatti: [...(c.contatti || [])] }));
  const by = new Map(base.map(c => [key(c.nome), c]));
  queue.nuoviClienti.forEach(n => {
    if (by.has(key(n.nome))) return;
    const c = { nome: n.nome, tipologia: n.tipologia, canale: n.canale, zona: n.zona, sales: data && data.operatore || '', quotation: '', foodtesting: '', account: '', prossimaAzione: '', dataProssima: '', priorita: '', note: '', contatti: n.contatto ? [{ nome: n.contatto, ruolo: n.ruolo || '' }] : [], visite: [], samplesAperti: [], _pend: true, _err: n._errore };
    base.push(c); by.set(key(c.nome), c);
  });
  const ultima = new Map(base.map(c => [key(c.nome), c.visite.reduce((m, v) => v.data > m ? v.data : m, '')]));
  queue.visite.slice().sort((a, b) => (a.data + a.creata).localeCompare(b.data + b.creata)).forEach(v => {
    const c = by.get(key(v.cliente)); if (!c) return;
    c.visite.push({ ...v, _pend: true, _err: v._errore });
    (v.samples || []).forEach((s, i) => c.samplesAperti.push({ id: v.id + '-s' + (i + 1), data: v.data, prodotto: s.prod, qty: s.qty, feedback: 'In attesa', _pend: true }));
    if (v.nuovoContatto && !c.contatti.some(k => norm(k.nome) === norm(v.nuovoContatto.nome))) c.contatti.push({ ...v.nuovoContatto });
    const k = key(c.nome);
    if (v.data >= (ultima.get(k) || '')) {
      ultima.set(k, v.data);
      Object.entries(v.stato || {}).forEach(([f, val]) => { if (val) c[f] = val; });
      if (v.step) c.prossimaAzione = v.step;
      if (v.follow) c.dataProssima = v.follow;
      if (v.priorita) c.priorita = v.priorita;
      if (typeof v.note === 'string') c.note = v.note;
    }
  });
  const fb = new Map(queue.feedback.map(f => [f.id, f]));
  base.forEach(c => {
    c.visite.sort((a, b) => String(b.data).localeCompare(String(a.data)));
    c.samplesAperti = c.samplesAperti.filter(s => !(fb.has(s.id) && fb.get(s.id).feedback !== 'In attesa'));
    c._pendVisite = c.visite.filter(v => v._pend).length;
  });
  return base;
}

/* ---------- barra di stato ---------- */
function renderBar() {
  const on = navigator.onLine;
  $('#syncbar').hidden = !cfg;
  if (!cfg) return;
  $('#net').className = 'net ' + (on ? 'on' : 'off');
  $('#net').textContent = on ? 'Online' : 'Offline';
  const n = pendingCount(), errs = [...queue.nuoviClienti, ...queue.visite, ...queue.feedback].filter(x => x._errore).length;
  const qb = $('#queueBtn');
  qb.className = 'queue' + (n ? ' pend' : '');
  qb.textContent = n ? `${n} da inviare${errs ? ` · ${errs} con errore` : ''}` : 'Tutto inviato';
  $('#syncBtn').disabled = syncing || !on;
  $('#syncBtn').textContent = syncing ? 'Invio in corso…' : 'Sincronizza';
  $('#last').textContent = data && data.syncedAt ? 'Dati del ' + fmtTime(data.syncedAt) : '';
  $('#opLine').textContent = data && data.operatore ? `Is Mellus · ${data.operatore}` : 'Is Mellus · Sales Dubai';
}

/* ---------- lista clienti ---------- */
function renderList() {
  if (!cfg) { $('#paneList').hidden = true; return; }
  $('#paneList').hidden = false;
  const q = norm(ui.q), op = data && data.operatore;
  const rows = clienti().filter(c => {
    if (ui.filter === 'late' && !isLate(c)) return false;
    if (ui.filter === 'mine' && c.sales !== op) return false;
    if (['SI', 'NO', 'BSS'].includes(ui.filter) && c.account !== ui.filter) return false;
    return !q || norm(c.nome).includes(q) || c.contatti.some(k => norm(k.nome).includes(q));
  }).sort((a, b) => a.nome.localeCompare(b.nome));
  $('#count').textContent = `${rows.length} clienti`;
  $('#list').innerHTML = rows.map(c => {
    const sub = c.dataProssima ? `<span class="${isLate(c) ? 'late' : ''}">${fmt(c.dataProssima)}</span> · ${esc(c.prossimaAzione)}` : esc(c.note || 'Nessuna nota');
    const tag = c._pend ? '<span class="tag">nuovo</span>' : (c._pendVisite ? `<span class="tag">${c._pendVisite} da inviare</span>` : '');
    return `<li><button type="button" data-n="${esc(c.nome)}" aria-current="${ui.sel === c.nome}"><span class="cname">${esc(c.nome)}${tag}</span>${pill(c.account)}<span class="csub">${sub}</span></button></li>`;
  }).join('') || `<li class="empty" style="padding:12px 4px">Nessun cliente trovato. <button class="btn ghost" type="button" data-act="new">Crealo come nuovo cliente</button></li>`;
}

/* ---------- pannello principale ---------- */
function renderMain() {
  const m = $('#main');
  $('#grid').classList.toggle('has-detail', !cfg || ui.view !== 'welcome');
  $('#grid').classList.toggle('setup-mode', !cfg);
  if (!cfg) { m.innerHTML = setupHTML(); bindMain(); return; }
  const c = ui.sel ? clienti().find(x => x.nome === ui.sel) : null;
  if ((ui.view === 'detail' || ui.view === 'visit') && !c) ui.view = 'welcome';
  if (ui.view === 'welcome') m.innerHTML = welcomeHTML();
  else if (ui.view === 'detail') m.innerHTML = detailHTML(c);
  else if (ui.view === 'visit') m.innerHTML = visitHTML(c);
  else if (ui.view === 'new') m.innerHTML = newHTML();
  else if (ui.view === 'queue') m.innerHTML = queueHTML();
  else if (ui.view === 'ok') m.innerHTML = okHTML();
  bindMain();
}
function go(view, sel) { if (sel !== undefined) ui.sel = sel; ui.view = view; ui.confirmDel = null; renderList(); renderMain(); window.scrollTo({ top: 0 }); }

function setupHTML() {
  return `<div class="setup"><h1>Collega il dispositivo</h1>
  <p>Inserisci l'indirizzo del server e il tuo codice operatore. Li trovi nella guida di installazione: li dà Alberto. Serve farlo una volta sola, con la connessione attiva.</p>
  <form id="sf" novalidate style="margin-top:16px">
   <label>Indirizzo del server (finisce con /exec)<input type="url" id="s_url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg && cfg.url || '')}" autocomplete="off"></label>
   <label>Codice operatore<input type="password" id="s_tok" autocomplete="off"></label>
   <p class="err" id="s_err" hidden></p>
   <button class="btn primary" type="submit" id="s_go">Collega e scarica i clienti</button>
  </form></div>`;
}
function welcomeHTML() {
  const n = pendingCount();
  return `<div class="welcome"><h1 style="color:var(--fg)">Scegli un cliente</h1>
  <p>Cerca il cliente nella lista e tocca <b>Registra visita</b>. Per un cliente nuovo usa <b>+ Nuovo</b>.</p>
  <p>Funziona anche senza connessione: le visite restano salvate su questo dispositivo e vengono inviate al foglio quando torna la rete, oppure quando premi <b>Sincronizza</b>.</p>
  ${n ? `<p class="warn">Hai ${n} ${n === 1 ? 'elemento' : 'elementi'} da inviare. Sincronizza a fine giornata, con il Wi-Fi o la rete mobile.</p>` : ''}</div>`;
}
function detailHTML(c) {
  const vis = c.visite.slice(0, 5);
  return `<button class="btn ghost back" type="button" data-act="home">← Clienti</button>
  ${c._err ? `<div class="msg err">Il cliente non è stato creato sul foglio: ${esc(c._err)}</div>` : ''}
  <div class="d-head"><div><h1>${esc(c.nome)}${c._pend ? '<span class="tag">nuovo · da inviare</span>' : ''}</h1><div class="meta">${esc([c.tipologia, c.canale, c.zona, c.sales && 'Sales: ' + c.sales].filter(Boolean).join(' · ') || 'Anagrafica da completare')}</div></div>
  <button class="btn primary" type="button" data-act="visit">Registra visita</button></div>
  <div class="status"><div class="st"><span>Quotation</span>${pill(c.quotation)}</div><div class="st"><span>Food testing</span>${pill(c.foodtesting)}</div><div class="st"><span>Account</span>${pill(c.account)}</div></div>
  <div class="next"><div><h2 style="margin:0 0 4px">Prossima azione${c.priorita ? ' · priorità ' + esc(c.priorita) : ''}</h2>${c.prossimaAzione ? esc(c.prossimaAzione) : '<span class="empty">Non impostata</span>'}</div><div class="when ${isLate(c) ? 'late' : ''}">${c.dataProssima ? fmt(c.dataProssima) + (isLate(c) ? ' · scaduta' : '') : ''}</div></div>
  ${c.note ? `<div><h2>Note / stato attuale</h2><div class="note">${esc(c.note)}</div></div>` : ''}
  <div class="two">
   <div><h2>Contatti</h2><div class="contacts">${c.contatti.map(k => `<div>${esc(k.nome)}${k.ruolo ? ` <span>· ${esc(k.ruolo)}</span>` : ''}</div>`).join('') || '<span class="empty">Nessun contatto</span>'}</div>
   ${c.samplesAperti.length ? `<h2 style="margin-top:18px">Samples senza feedback</h2><div class="contacts">${c.samplesAperti.map(s => `<div>${esc(s.prodotto)}${s.qty ? ' ×' + esc(s.qty) : ''} <span>· ${fmt(s.data)}</span></div>`).join('')}</div>` : ''}</div>
   <div><h2>Ultime visite${c.nVisite > 5 ? ` (${c.nVisite} in totale)` : ''}</h2>${vis.length ? `<ul class="tl">${vis.map(v => `<li class="${v._pend ? 'pend' : ''}"><div class="t-d">${fmt(v.data)} · ${esc(v.tipo)} · ${esc(v.op || (data && data.operatore) || '')}${v._pend ? `<span class="tag${v._err ? ' err' : ''}">${v._err ? 'errore' : 'da inviare'}</span>` : ''}</div><div class="t-x">${esc(v.esito)}</div></li>`).join('')}</ul>` : '<p class="empty">Nessuna visita registrata.</p>'}</div>
  </div>`;
}
const seg = (name, val, vals) => `<div class="seg" role="group" data-seg="${name}" data-orig="${esc(val || '')}">${vals.map(v => `<button type="button" data-v="${v}" aria-pressed="${v === val}">${v}</button>`).join('')}</div>`;
const R = req => req ? ' <span class="req">*</span>' : '';
function visitHTML(c) {
  const ob = CONFIG.obbligatori;
  return `<button class="btn ghost back" type="button" data-act="detail">← ${esc(c.nome)}</button>
  <div><h1>Nuova visita</h1><div class="meta">${esc(c.nome)} · ${esc(data && data.operatore || '')}</div></div>
  <form id="vf" novalidate>
   <fieldset><legend>La visita</legend>
    <div class="row c2"><label>Data${R(1)}<input type="date" id="v_data" value="${today()}"></label>
    <label>Tipo<select id="v_tipo">${opts(lista('Tipo visita'), 'Visita')}</select></label></div>
    <label>Contatto incontrato<select id="v_cont">${opts(c.contatti.map(k => k.nome).concat(['Altro / nuovo contatto']), c.contatti[0] && c.contatti[0].nome)}</select></label>
    <div class="row c2" id="v_newcont" hidden><label>Nome nuovo contatto<input type="text" id="v_nc_nome"></label><label>Ruolo<input type="text" id="v_nc_ruolo" placeholder="es. executive chef"></label></div>
    <label>Descrizione / esito${R(ob.esito)}<textarea id="v_esito" placeholder="Cosa è successo, cosa ha detto il cliente"></textarea></label>
    <label>Prodotti discussi<input type="text" id="v_prod" placeholder="es. Pecorino Sardo DOP, Bottarga"></label>
   </fieldset>
   ${c.samplesAperti.length ? `<fieldset><legend>Feedback sui samples lasciati</legend>${c.samplesAperti.map(s => `<div class="fbrow"><div>${esc(s.prodotto)}${s.qty ? ' ×' + esc(s.qty) : ''} <span class="t-d">· ${fmt(s.data)}</span></div><select data-fb="${esc(s.id)}" aria-label="Feedback ${esc(s.prodotto)}"><option value="">Nessun feedback</option>${opts(lista('Feedback samples').filter(x => x !== 'In attesa'))}</select></div>`).join('')}</fieldset>` : ''}
   <fieldset><legend>Samples lasciati oggi</legend><div id="samples"></div><button class="btn" type="button" id="addS">+ Aggiungi sample</button></fieldset>
   <fieldset><legend>Quotazioni / prezzi</legend><div id="quots"></div><button class="btn" type="button" id="addQ">+ Aggiungi prezzo</button></fieldset>
   <fieldset><legend>Stato commerciale</legend>
    <div class="row c3"><label>Quotation${seg('quotation', c.quotation, ['SI', 'NO'])}</label><label>Food testing${seg('foodtesting', c.foodtesting, ['SI', 'NO'])}</label><label>Account${seg('account', c.account, ['SI', 'NO', 'BSS'])}</label></div>
   </fieldset>
   <fieldset><legend>Prossimo passo</legend>
    <label>Prossima azione${R(ob.step)}<input type="text" id="v_step" placeholder="es. Inviare listino aggiornato"></label>
    <div class="row c2"><label>Data follow-up${R(ob.follow)}<input type="date" id="v_follow"></label><label>Priorità<select id="v_prio" data-orig="${esc(c.priorita || '')}"><option value="">—</option>${opts(lista('Priorità'), c.priorita)}</select></label></div>
    <label>Note / stato attuale (sostituisce la nota nella scheda)<textarea id="v_note" data-orig="${esc(c.note || '')}">${esc(c.note || '')}</textarea></label>
   </fieldset>
   <p class="err" id="v_err" hidden></p>
   <div class="actions"><button class="btn" type="button" data-act="detail">Annulla</button><button class="btn primary" type="submit">Salva visita</button></div>
  </form>`;
}
const sampleRow = () => `<div class="rep"><button class="btn ghost x" type="button" data-del aria-label="Rimuovi sample">✕</button><div class="row c3"><label>Prodotto<input type="text" data-k="prod"></label><label>Codice<input type="text" data-k="cod"></label><label>Quantità<input type="number" min="0" inputmode="decimal" data-k="qty"></label></div></div>`;
const quotRow = () => `<div class="rep"><button class="btn ghost x" type="button" data-del aria-label="Rimuovi prezzo">✕</button><div class="row c3"><label>Prodotto<input type="text" data-k="prod"></label><label>Codice<input type="text" data-k="cod"></label><label>Formato / UoM<input type="text" data-k="fmt" placeholder="es. kg, cartone 6×1kg"></label></div><div class="row c3"><label>Listino (AED)<input type="number" step="0.01" min="0" inputmode="decimal" data-k="list"></label><label>Offerto (AED)<input type="number" step="0.01" min="0" inputmode="decimal" data-k="off"></label><div class="disc" data-disc>Sconto —</div></div><div class="row c2"><label>Stato<select data-k="stato">${opts(lista('Stato quotazione'), 'Inviata')}</select></label><label>Valida fino a<input type="date" data-k="valida"></label></div></div>`;
function newHTML() {
  return `<button class="btn ghost back" type="button" data-act="home">← Clienti</button>
  <div><h1>Nuovo cliente</h1><div class="meta">La scheda viene creata sul foglio alla prossima sincronizzazione</div></div>
  <form id="nf" novalidate>
   <fieldset>
    <label>Nome cliente${R(1)}<input type="text" id="n_nome" placeholder="es. Marriott Downtown" autocomplete="off" value="${esc(ui.q)}"></label>
    <div id="n_dup" class="warn" hidden></div>
    <div class="row c2"><label>Tipologia<select id="n_tip"><option value="">—</option>${opts(lista('Tipologia'))}</select></label><label>Canale acquisto<select id="n_can"><option value="">—</option>${opts(lista('Canale acquisto'))}</select></label></div>
    <label>Zona / Area<input type="text" id="n_zona" placeholder="es. Business Bay"></label>
    <div class="row c2"><label>Contatto principale<input type="text" id="n_cont" placeholder="Nome"></label><label>Ruolo<input type="text" id="n_ruolo" placeholder="es. executive chef"></label></div>
   </fieldset>
   <p class="err" id="n_err" hidden></p>
   <div class="actions"><button class="btn" type="button" data-act="home">Annulla</button><button class="btn primary" type="submit">Crea e registra visita</button></div>
  </form>`;
}
function queueHTML() {
  const item = (tipo, x, titolo, sotto) => `<div class="qitem"><div class="t-x"><div class="t-d">${tipo}${x._errore ? '<span class="tag err">errore</span>' : ''}</div><b>${esc(titolo)}</b><div>${esc(sotto)}</div>${x._errore ? `<p class="err">${esc(x._errore)}</p>` : ''}</div>
   <button class="btn ${ui.confirmDel === x.id ? 'danger' : 'ghost'}" type="button" data-qdel="${esc(x.id)}">${ui.confirmDel === x.id ? 'Conferma: elimina' : 'Elimina'}</button></div>`;
  const all = [
    ...queue.nuoviClienti.map(x => item('Nuovo cliente', x, x.nome, [x.tipologia, x.zona].filter(Boolean).join(' · '))),
    ...queue.visite.map(x => item(`Visita del ${fmt(x.data)}`, x, x.cliente, x.esito)),
    ...queue.feedback.map(x => item('Feedback sample', x, x.prodotto || x.id, x.feedback)),
  ];
  return `<button class="btn ghost back" type="button" data-act="home">← Clienti</button>
  <div><h1>Da inviare</h1><div class="meta">Salvati su questo dispositivo, non ancora sul foglio Google</div></div>
  ${all.length ? all.join('') : '<p class="empty">Niente da inviare: il foglio è aggiornato.</p>'}
  <div class="actions" style="position:static"><button class="btn" type="button" id="copyQ">Copia dati in sospeso</button><button class="btn primary" type="button" data-act="sync">Sincronizza ora</button></div>
  <textarea id="copyArea" hidden readonly style="min-height:160px;font-family:var(--f-mono);font-size:12px"></textarea>
  <div><h2>Dispositivo</h2><p class="meta">Server: <code>${esc(cfg.url)}</code></p><p class="meta">Operatore: ${esc(data && data.operatore || '—')}</p>
  <button class="btn ${ui.confirmDel === '__logout' ? 'danger' : ''}" type="button" id="logout">${ui.confirmDel === '__logout' ? (pendingCount() ? `Attenzione: ${pendingCount()} elementi non inviati andranno persi. Conferma` : 'Conferma scollegamento') : 'Scollega questo dispositivo'}</button></div>`;
}
function okHTML() {
  const i = ui.okInfo || {};
  return `<div><h1 style="color:var(--si)">Visita salvata</h1><div class="meta">${esc(i.cliente || '')}</div></div>
  <div class="msg ${!queue.visite.some(v => v.id === i.id) ? 'ok' : navigator.onLine ? 'info' : 'warn'}">${!queue.visite.some(v => v.id === i.id) ? 'Inviata e scritta sul foglio.' : syncing ? 'Salvata sul dispositivo. Invio al foglio in corso…' : navigator.onLine ? 'Salvata sul dispositivo. Verrà inviata alla prossima sincronizzazione.' : 'Salvata sul dispositivo. Sei offline: verrà inviata al foglio alla prossima sincronizzazione.'}</div>
  <div class="actions" style="position:static;border:0"><button class="btn" type="button" data-act="detail">Apri scheda cliente</button><button class="btn primary" type="button" data-act="home">Altro cliente</button></div>`;
}

/* ---------- eventi ---------- */
function bindMain() {
  document.querySelectorAll('#main [data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'home') go('welcome', null);
    else if (a === 'sync') sync(true);
    else if (a === 'new') openNew();
    else go(a);
  });
  document.querySelectorAll('#main .seg').forEach(s => s.onclick = e => { const b = e.target.closest('button'); if (!b) return; const was = b.getAttribute('aria-pressed') === 'true'; s.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', !was && x === b)); });
  const sf = $('#sf'); if (sf) sf.onsubmit = e => { e.preventDefault(); connect(); };
  const vf = $('#vf');
  if (vf) {
    const cont = $('#v_cont'), upd = () => $('#v_newcont').hidden = cont.value !== 'Altro / nuovo contatto';
    cont.onchange = upd; upd();
    const add = (id, html) => { const w = document.createElement('div'); w.innerHTML = html; $(id).appendChild(w.firstChild); w.remove(); $(id).lastChild.querySelector('input').focus(); };
    $('#addS').onclick = () => add('#samples', sampleRow());
    $('#addQ').onclick = () => add('#quots', quotRow());
    vf.addEventListener('click', e => { if (e.target.closest('[data-del]')) e.target.closest('.rep').remove(); });
    vf.addEventListener('input', e => { const r = e.target.closest('.rep'); if (!r || !r.querySelector('[data-disc]')) return; const l = +r.querySelector('[data-k=list]').value, o = +r.querySelector('[data-k=off]').value; r.querySelector('[data-disc]').textContent = l > 0 && o > 0 ? `Sconto ${Math.round((1 - o / l) * 1000) / 10}%` : 'Sconto —'; });
    vf.onsubmit = e => { e.preventDefault(); saveVisit(); };
  }
  const nf = $('#nf');
  if (nf) {
    const chk = () => { const s = similar($('#n_nome').value); $('#n_dup').hidden = !s.length; $('#n_dup').innerHTML = s.length ? `Esiste già un cliente simile: <b>${s.map(esc).join(', ')}</b>. Controlla prima di crearne uno nuovo.` : ''; };
    $('#n_nome').oninput = chk; chk();
    nf.onsubmit = e => { e.preventDefault(); saveNew(); };
  }
  document.querySelectorAll('#main [data-qdel]').forEach(b => b.onclick = () => {
    const id = b.dataset.qdel;
    if (ui.confirmDel !== id) { ui.confirmDel = id; renderMain(); return; }
    ['nuoviClienti', 'visite', 'feedback'].forEach(l => queue[l] = queue[l].filter(x => x.id !== id));
    saveQueue(); ui.confirmDel = null; renderBar(); renderList(); renderMain();
  });
  const cq = $('#copyQ');
  if (cq) cq.onclick = async () => {
    const txt = JSON.stringify({ esportato: new Date().toISOString(), operatore: data && data.operatore, ...queue }, null, 1);
    const ta = $('#copyArea'); ta.value = txt; ta.hidden = false;
    try { await navigator.clipboard.writeText(txt); flash('ok', 'Dati copiati. Incollali in una email o in WhatsApp ad Alberto.'); }
    catch (e) { ta.focus(); ta.select(); flash('info', 'Testo selezionato qui sotto: copialo a mano.'); }
  };
  const lo = $('#logout');
  if (lo) lo.onclick = () => {
    if (ui.confirmDel !== '__logout') { ui.confirmDel = '__logout'; renderMain(); return; }
    ['rv_cfg', 'rv_data', 'rv_queue'].forEach(k => { try { localStorage.removeItem(k); } catch (e) { } });
    cfg = null; data = null; queue = { nuoviClienti: [], visite: [], feedback: [] }; ui = { ...ui, sel: null, view: 'welcome', confirmDel: null };
    render();
  };
}
function similar(name) {
  const n = norm(name); if (n.length < 3) return [];
  return clienti().filter(c => { const m = norm(c.nome); return m === n || m.includes(n) || n.includes(m); }).map(c => c.nome).slice(0, 5);
}
function openNew() { go('new', null); }

function saveNew() {
  const nome = $('#n_nome').value.trim().toUpperCase().replace(/\s+/g, ' '), err = $('#n_err');
  if (!nome) { err.hidden = false; err.textContent = 'Scrivi il nome del cliente.'; return; }
  if (clienti().some(c => key(c.nome) === key(nome))) { err.hidden = false; err.textContent = 'Questo cliente esiste già: cercalo nella lista.'; return; }
  const n = { id: 'c-' + uid(), nome, tipologia: $('#n_tip').value, canale: $('#n_can').value, zona: $('#n_zona').value.trim(), contatto: $('#n_cont').value.trim(), ruolo: $('#n_ruolo').value.trim(), creato: today() };
  queue.nuoviClienti.push(n);
  if (!saveQueue()) { queue.nuoviClienti.pop(); return; }
  ui.q = ''; $('#q').value = '';
  renderBar(); go('visit', nome);
}

function saveVisit() {
  const c = clienti().find(x => x.nome === ui.sel), err = $('#v_err'), ob = CONFIG.obbligatori;
  const g = id => $(id).value.trim();
  const fail = (t, id) => { err.hidden = false; err.textContent = t; if (id) $(id).focus(); };
  if (!g('#v_data')) return fail('Inserisci la data della visita.', '#v_data');
  if (ob.esito && !g('#v_esito')) return fail('Scrivi l\'esito della visita.', '#v_esito');
  if (ob.step && !g('#v_step')) return fail('Scrivi la prossima azione: senza, il cliente sparisce dai follow-up.', '#v_step');
  if (ob.follow && !g('#v_follow')) return fail('Inserisci la data del follow-up.', '#v_follow');
  const nuovo = $('#v_cont').value === 'Altro / nuovo contatto';
  if (nuovo && !g('#v_nc_nome')) return fail('Scrivi il nome del nuovo contatto o scegline uno dalla lista.', '#v_nc_nome');
  const rows = sel => [...document.querySelectorAll(sel + ' .rep')].map(r => Object.fromEntries([...r.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value.trim()]))).filter(o => o.prod);
  const stato = {};
  document.querySelectorAll('#vf .seg').forEach(s => { const v = (s.querySelector('[aria-pressed=true]') || {}).dataset?.v || ''; if (v && v !== s.dataset.orig) stato[s.dataset.seg] = v; });
  const prio = $('#v_prio'), note = $('#v_note');
  const v = {
    id: uid(), creata: new Date().toISOString(), cliente: c.nome, data: g('#v_data'), tipo: $('#v_tipo').value,
    contatto: nuovo ? g('#v_nc_nome') : $('#v_cont').value, nuovoContatto: nuovo ? { nome: g('#v_nc_nome'), ruolo: g('#v_nc_ruolo') } : null,
    esito: g('#v_esito'), prodotti: g('#v_prod'), samples: rows('#samples'), quot: rows('#quots'), stato,
    step: g('#v_step'), follow: g('#v_follow'),
  };
  if (prio.value && prio.value !== prio.dataset.orig) v.priorita = prio.value;
  if (note.value.trim() !== (note.dataset.orig || '').trim()) v.note = note.value.trim();
  const fb = [...document.querySelectorAll('#vf [data-fb]')].filter(s => s.value).map(s => ({ id: s.dataset.fb, feedback: s.value, prodotto: s.closest('.fbrow').firstElementChild.textContent.split('·')[0].trim(), cliente: c.nome }));
  queue.visite.push(v); queue.feedback.push(...fb);
  if (!saveQueue()) { queue.visite.pop(); queue.feedback.splice(queue.feedback.length - fb.length, fb.length); return; }
  ui.okInfo = { cliente: c.nome, id: v.id };
  renderBar(); go('ok');
  if (navigator.onLine) sync(false);
}

/* ---------- collegamento e sincronizzazione ---------- */
async function call(url, opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 90000);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, redirect: 'follow', cache: 'no-store' });
    const txt = await res.text();
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('Risposta non valida dal server. Controlla l\'indirizzo e che la Web App sia pubblicata per "Chiunque".'); }
    if (!j.ok) throw new Error(j.error || 'Errore del server');
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Il server non ha risposto entro 90 secondi.');
    if (e instanceof TypeError) throw new Error('Connessione al server non riuscita.');
    throw e;
  } finally { clearTimeout(t); }
}
// il codice operatore viaggia solo nel corpo della richiesta, mai nell'indirizzo
const post = body => call(cfg.url, { method: 'POST', body: JSON.stringify({ token: cfg.token, ...body }) });

async function connect() {
  const url = $('#s_url').value.trim(), token = $('#s_tok').value.trim(), err = $('#s_err');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) { err.hidden = false; err.textContent = 'L\'indirizzo deve iniziare con https://script.google.com/macros/s/ e finire con /exec.'; return; }
  if (!token) { err.hidden = false; err.textContent = 'Inserisci il codice operatore.'; return; }
  if (!navigator.onLine) { err.hidden = false; err.textContent = 'Serve la connessione per il primo collegamento.'; return; }
  $('#s_go').disabled = true; $('#s_go').textContent = 'Collegamento…';
  try {
    cfg = { url, token };
    const j = await post({});
    data = { ...j.dati, operatore: j.operatore, syncedAt: new Date().toISOString() };
    store.set(K.cfg, cfg); store.set(K.data, data);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
    flash('ok', `Collegato come <b>${esc(j.operatore)}</b>. ${data.clienti.length} clienti scaricati: ora l'app funziona anche offline.`);
    render();
  } catch (e) {
    cfg = store.get(K.cfg, null);
    err.hidden = false; err.textContent = e.message;
    $('#s_go').disabled = false; $('#s_go').textContent = 'Collega e scarica i clienti';
  }
}

async function sync(manual) {
  if (syncing || !cfg) return;
  if (!navigator.onLine) { if (manual) flash('warn', 'Sei offline. I dati restano salvati sul dispositivo: sincronizza quando torna la connessione.'); return; }
  syncing = true; renderBar();
  const strip = x => { const { _errore, ...r } = x; return r; };
  const body = { nuoviClienti: queue.nuoviClienti.map(strip), visite: queue.visite.map(strip), feedback: queue.feedback.map(({ prodotto, cliente, ...f }) => strip(f)) };
  const n = body.nuoviClienti.length + body.visite.length + body.feedback.length;
  try {
    const j = await post(body);
    let ok = 0, ko = 0; const avvisi = [];
    if (j.risultati) {
      const done = new Set(), errs = {};
      ['clienti', 'visite', 'feedback'].forEach(l => (j.risultati[l] || []).forEach(r => {
        if (FATTO.includes(r.esito)) { done.add(r.id); ok++; if (r.avviso) avvisi.push(r.avviso); }
        else { errs[r.id] = r.errore || 'Errore sconosciuto'; ko++; }
      }));
      ['nuoviClienti', 'visite', 'feedback'].forEach(l => {
        queue[l] = queue[l].filter(x => !done.has(x.id)).map(x => errs[x.id] ? { ...x, _errore: errs[x.id] } : x);
      });
      saveQueue();
    }
    data = { ...j.dati, operatore: j.operatore, syncedAt: new Date().toISOString() };
    store.set(K.data, data);
    if (ko) flash('err', `Inviati ${ok}, ${ko} non inviati: apri <b>Da inviare</b> per vedere il motivo.`);
    else if (n) flash('ok', `Sincronizzazione completata: ${ok} ${ok === 1 ? 'elemento inviato' : 'elementi inviati'} al foglio.${avvisi.length ? ' ' + esc(avvisi.join(' ')) : ''}`);
    else if (manual) flash('ok', 'Dati aggiornati dal foglio.');
  } catch (e) {
    flash('err', `Sincronizzazione non riuscita: ${esc(e.message)} I dati restano salvati sul dispositivo.`);
  } finally {
    syncing = false;
    renderBar(); renderList(); if (ui.view !== 'visit' && ui.view !== 'new') renderMain();
  }
}

function render() { renderBar(); renderList(); renderMain(); }

/* ---------- avvio ---------- */
$('#q').oninput = e => { ui.q = e.target.value; renderList(); };
$('#newBtn').onclick = openNew;
document.querySelectorAll('.chip').forEach(ch => ch.onclick = () => { ui.filter = ch.dataset.f; document.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', x === ch)); renderList(); });
$('#list').onclick = e => { const b = e.target.closest('button[data-n]'); if (b) go('detail', b.dataset.n); else if (e.target.closest('[data-act=new]')) openNew(); };
$('#syncBtn').onclick = () => sync(true);
$('#queueBtn').onclick = () => go('queue');
window.addEventListener('online', () => { renderBar(); sync(false); });
window.addEventListener('offline', renderBar);
setInterval(() => { if (pendingCount() && navigator.onLine) sync(false); }, 5 * 60 * 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
render();
if (cfg && navigator.onLine) sync(false);

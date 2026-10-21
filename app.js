'use strict';
/* Registro Visite – Is Mellus (v2). App offline-first: tutto viene salvato sul dispositivo
   e inviato al foglio Google quando c'è connessione (automaticamente o con "Sincronizza"). */

const CONFIG = {
  obbligatori: { esito: true, esitoVisita: true, step: true, follow: true }, // campi obbligatori nella visita
  visiteMostrate: 10, // nello storico della scheda; le altre con "Mostra tutte"
};
const K = { cfg: 'rv_cfg', data: 'rv_data', queue: 'rv_queue', sort: 'rv_sort' };
// Semaforo dell'ultima interazione (giorni): fino a 7 verde, fino a 14 arancione, fino a 30 rosso, oltre nero.
// Stesse soglie della colonna "Giorni" nell'INDICE del foglio (installaSemaforo in Registro.gs).
const SEMAFORO = [7, 14, 30];
const ORDINI = { az: 'Nome A → Z', za: 'Nome Z → A', vecchia: 'Da più tempo senza visita', recente: 'Visitati di recente', prio: 'Priorità', prossima: 'Prossima azione' };
const DEF_LISTE = {
  'Tipo visita': ['Visita', 'Call', 'Email/WhatsApp', 'Meeting', 'Food testing', 'Consegna samples', 'Altro'],
  'Tipologia': ['Hotel', 'Ristorante', 'Retail / Market', 'Catering', 'Cloud kitchen', 'Altro'],
  'Canale acquisto': ['Diretto', 'BSS (Birch Street)', 'Distributore', 'Altro'],
  'Priorità': ['Alta', 'Media', 'Bassa'],
  'Feedback samples': ['In attesa', 'Positivo', 'Negativo', 'Da ripetere'],
  'Stato quotazione': ['Inviata', 'Accettata', 'Rifiutata', 'In negoziazione', 'Scaduta'],
  'Esito visita': ['Positivo', 'Interessato', 'Neutro', 'Negativo'],
};
const IN_ATTESA = ['', 'Inviata', 'In negoziazione']; // quotazioni che aspettano una risposta
const FATTO = ['scritta', 'duplicato', 'creato', 'esistente', 'scritto', 'superato'];
const LISTE_CODA = ['nuoviClienti', 'visite', 'feedback', 'risposte'];

/* ---------- memoria del dispositivo ---------- */
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};
const codaVuota = () => ({ nuoviClienti: [], visite: [], feedback: [], risposte: [] });
let cfg = store.get(K.cfg, null);
let data = store.get(K.data, null);
let queue = { ...codaVuota(), ...(store.get(K.queue, null) || {}) };
let ui = { calMese: null, calGiorno: null, sel: null, selQ: null, view: 'dash', filter: 'all', q: '', okInfo: null, confirmDel: null, tutte: false, sort: ORDINI[store.get(K.sort, 'az')] ? store.get(K.sort, 'az') : 'az' };
let syncing = false;

function saveQueue() {
  if (store.set(K.queue, queue)) return true;
  flash('err', 'Il dispositivo non riesce a salvare (memoria piena o navigazione privata). Non chiudere l\'app: sincronizza appena possibile.');
  return false;
}
function pendingCount() { return LISTE_CODA.reduce((n, l) => n + queue[l].length, 0); }

/* ---------- utilità ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const key = s => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const isoDay = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => isoDay(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDay(d); };
const fmt = d => { if (!d) return ''; const [y, m, g] = String(d).slice(0, 10).split('-'); return g ? `${g}/${m}/${y}` : String(d); };
const fmtTime = iso => { if (!iso) return ''; const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const giorni = iso => iso ? Math.round((new Date(today() + 'T12:00:00') - new Date(String(iso).slice(0, 10) + 'T12:00:00')) / 864e5) : 0;
const money = n => (n === '' || n == null || isNaN(+n)) ? '' : (+n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n === '' || n == null || isNaN(+n)) ? '' : `${Math.round(+n * 1000) / 10}%`;
const num = v => { if (v === '' || v == null) return ''; const n = Number(String(v).replace(',', '.')); return isNaN(n) ? '' : n; };
const uid = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const lista = h => (data && data.liste && data.liste[h] && data.liste[h].length) ? data.liste[h] : (DEF_LISTE[h] || []);
const pill = v => `<span class="pill p-${['SI', 'NO', 'BSS'].includes(v) ? v : 'nd'}">${esc(v || 'n.d.')}</span>`;
const TONO = { Accettata: 'SI', Positivo: 'SI', Interessato: 'SI', Rifiutata: 'NO', Negativo: 'NO', Scaduta: 'NO', 'Da ripetere': 'BSS', Inviata: 'BSS', 'In negoziazione': 'BSS', 'In attesa': 'BSS' };
const pillT = v => v ? `<span class="pill p-${TONO[v] || 'nd'}">${esc(v)}</span>` : '';
const nRiga = q => { const m = String(q.id || '').match(/-q(\d+)$/); return m ? +m[1] : 0; };
const perRiga = (a, b) => String(a.idVisita || a.data).localeCompare(String(b.idVisita || b.data)) || nRiga(a) - nRiga(b);
const opts = (arr, sel) => arr.map(o => `<option${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');
const isLate = c => c.dataProssima && c.dataProssima < today();
const me = () => (data && data.operatore) || '';
// Ultima interazione: la più recente tra quella del foglio (INDICE, colonna "Ultima interazione")
// e le visite in memoria, comprese quelle registrate offline e non ancora inviate.
const ultimaInt = c => [c.ultima || '', ...c.visite.map(v => v.data || '')].reduce((m, d) => String(d).slice(0, 10) > m ? String(d).slice(0, 10) : m, '');
function semaforo(c) {
  const u = ultimaInt(c);
  if (!u) return { cls: 'sv-n', gg: null, testo: 'mai', titolo: 'Nessuna visita registrata' };
  const gg = Math.max(0, giorni(u));
  const cls = gg <= SEMAFORO[0] ? 'sv-g' : gg <= SEMAFORO[1] ? 'sv-o' : gg <= SEMAFORO[2] ? 'sv-r' : 'sv-k';
  return { cls, gg, testo: gg === 0 ? 'oggi' : gg + ' gg', titolo: 'Ultima interazione ' + fmt(u) };
}
const badgeSV = c => { const s = semaforo(c); return `<span class="sv ${s.cls}" title="${esc(s.titolo)}">${s.testo}</span>`; };
const PRIO = { Alta: 0, Media: 1, Bassa: 2 };
const ordina = {
  az: (a, b) => a.nome.localeCompare(b.nome),
  za: (a, b) => b.nome.localeCompare(a.nome),
  vecchia: (a, b) => (ultimaInt(a) || '0').localeCompare(ultimaInt(b) || '0') || a.nome.localeCompare(b.nome), // mai visitati in cima
  recente: (a, b) => (ultimaInt(b) || '0').localeCompare(ultimaInt(a) || '0') || a.nome.localeCompare(b.nome),
  prio: (a, b) => (PRIO[a.priorita] ?? 9) - (PRIO[b.priorita] ?? 9) || (ultimaInt(a) || '0').localeCompare(ultimaInt(b) || '0') || a.nome.localeCompare(b.nome),
  prossima: (a, b) => (a.dataProssima || '9999').localeCompare(b.dataProssima || '9999') || a.nome.localeCompare(b.nome),
};
function flash(kind, text) {
  $('#flash').innerHTML = text ? `<div class="msg ${kind}" role="status">${text}</div>` : '';
  if (kind === 'ok' || kind === 'info') { const t = text; setTimeout(() => { if ($('#flash').textContent.includes(t.replace(/<[^>]+>/g, '').slice(0, 20))) $('#flash').innerHTML = ''; }, 6000); }
}

/* ---------- vista dei clienti = dati del foglio + modifiche non ancora inviate ---------- */
function clienti() {
  const base = ((data && data.clienti) || []).map(c => ({
    ...c, visite: [...(c.visite || [])], contatti: [...(c.contatti || [])],
    samples: (c.samples || c.samplesAperti || []).map(s => ({ ...s })), quot: (c.quot || []).map(q => ({ ...q })),
  }));
  const by = new Map(base.map(c => [key(c.nome), c]));
  queue.nuoviClienti.forEach(n => {
    if (by.has(key(n.nome))) return;
    const c = { nome: n.nome, tipologia: n.tipologia, canale: n.canale, zona: n.zona, sales: me(), quotation: '', foodtesting: '', account: '', prossimaAzione: '', dataProssima: '', priorita: '', note: '', contatti: n.contatto ? [{ nome: n.contatto, ruolo: n.ruolo || '' }] : [], visite: [], samples: [], quot: [], _pend: true, _err: n._errore };
    base.push(c); by.set(key(c.nome), c);
  });
  const ultima = new Map(base.map(c => [key(c.nome), c.visite.reduce((m, v) => v.data > m ? v.data : m, '')]));
  queue.visite.slice().sort((a, b) => (a.data + a.creata).localeCompare(b.data + b.creata)).forEach(v => {
    const c = by.get(key(v.cliente)); if (!c) return;
    c.visite.push({ ...v, op: me(), _pend: true, _err: v._errore });
    (v.samples || []).forEach((s, i) => c.samples.unshift({ id: v.id + '-s' + (i + 1), data: v.data, prodotto: s.prod, codice: s.cod, qty: s.qty, a: v.contatto, feedback: 'In attesa', idVisita: v.id, _pend: true }));
    (v.quot || []).forEach((q, i) => {
      const l = num(q.list), o = num(q.off);
      c.quot.unshift({ id: v.id + '-q' + (i + 1), data: v.data, prodotto: q.prod, codice: q.cod, fmt: q.fmt, listino: l, offerto: o, sconto: l > 0 && o !== '' ? 1 - o / l : '', stato: q.stato, valida: q.valida, idVisita: v.id, op: me(), _pend: true });
    });
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
  const rs = new Map(); queue.risposte.slice().sort((a, b) => String(a.creata).localeCompare(String(b.creata))).forEach(r => rs.set(r.quot, r));
  base.forEach(c => {
    c.visite.sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.creata || '').localeCompare(String(a.creata || '')));
    c.samples.forEach(s => { if (fb.has(s.id)) { s.feedback = fb.get(s.id).feedback; s._pendF = true; } });
    c.quot.forEach(q => { const r = rs.get(q.id); if (r) { q.stato = r.stato || q.stato; q.nota = r.nota; if (r.valida) q.valida = r.valida; q._pendR = true; } });
    c.samplesAperti = c.samples.filter(s => !s.feedback || s.feedback === 'In attesa');
    c.quotAttesa = c.quot.filter(q => IN_ATTESA.includes(q.stato || ''));
    c._pendVisite = c.visite.filter(v => v._pend).length;
  });
  return base;
}

/* ---------- barra di stato ---------- */
function renderBar() {
  const on = navigator.onLine;
  $('#syncbar').hidden = !cfg; $('#tabs').hidden = !cfg;
  if (!cfg) return;
  $('#net').className = 'net ' + (on ? 'on' : 'off');
  $('#net').textContent = on ? 'Online' : 'Offline';
  const n = pendingCount(), errs = LISTE_CODA.flatMap(l => queue[l]).filter(x => x._errore).length;
  const qb = $('#queueBtn');
  qb.className = 'queue' + (n ? ' pend' : '');
  qb.textContent = n ? `${n} da inviare${errs ? ` · ${errs} con errore` : ''}` : 'Tutto inviato';
  $('#syncBtn').disabled = syncing || !on;
  $('#syncBtn').textContent = syncing ? 'Invio in corso…' : 'Sincronizza';
  $('#last').textContent = data && data.syncedAt ? 'Dati del ' + fmtTime(data.syncedAt) : '';
  $('#opLine').textContent = me() ? `Is Mellus · ${me()}` : 'Is Mellus · Sales Dubai';
  document.querySelectorAll('#tabs [data-nav]').forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === (['list', 'dash', 'cal'].includes(ui.view) ? ui.view : ''))));
}

/* ---------- lista clienti ---------- */
function renderList() {
  if (!cfg) { $('#paneList').hidden = true; return; }
  $('#paneList').hidden = false;
  const q = norm(ui.q), op = me(), t = today(), t7 = addDays(t, 7);
  document.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', x.dataset.f === ui.filter));
  const rows = clienti().filter(c => {
    if (ui.filter === 'late' && !isLate(c)) return false;
    if (ui.filter === 'soon' && !(c.dataProssima && c.dataProssima >= t && c.dataProssima <= t7)) return false;
    if (ui.filter === 'quot' && !c.quotAttesa.length) return false;
    if (ui.filter === 'mine' && c.sales !== op) return false;
    if (['SI', 'NO', 'BSS'].includes(ui.filter) && c.account !== ui.filter) return false;
    return !q || norm(c.nome).includes(q) || c.contatti.some(k => norm(k.nome).includes(q));
  }).sort(ordina[ui.sort] || ordina.az);
  $('#count').textContent = `${rows.length} clienti`;
  if ($('#sort').value !== ui.sort) $('#sort').value = ui.sort;
  $('#list').innerHTML = rows.map(c => {
    const sub = c.dataProssima ? `<span class="${isLate(c) ? 'late' : ''}">${fmt(c.dataProssima)}</span> · ${esc(c.prossimaAzione)}` : esc(c.note || 'Nessuna nota');
    const tag = c._pend ? '<span class="tag">nuovo</span>' : (c._pendVisite ? `<span class="tag">${c._pendVisite} da inviare</span>` : '');
    return `<li><button type="button" data-n="${esc(c.nome)}" aria-current="${ui.sel === c.nome && ['detail', 'visit', 'resp'].includes(ui.view)}"><span class="cname">${esc(c.nome)}${tag}</span><span class="cright">${badgeSV(c)}${pill(c.account)}</span><span class="csub">${sub}</span></button></li>`;
  }).join('') || `<li class="empty" style="padding:12px 4px">Nessun cliente trovato. <button class="btn ghost" type="button" data-act="new">Crealo come nuovo cliente</button></li>`;
}

/* ---------- pannello principale ---------- */
function renderMain() {
  const m = $('#main');
  $('#grid').classList.toggle('has-detail', !cfg || ui.view !== 'list');
  $('#grid').classList.toggle('setup-mode', !cfg);
  if (!cfg) { m.innerHTML = setupHTML(); bindMain(); return; }
  const c = ui.sel ? clienti().find(x => x.nome === ui.sel) : null;
  if (['detail', 'visit', 'resp'].includes(ui.view) && !c) ui.view = 'dash';
  const q = ui.view === 'resp' && c ? c.quot.find(x => x.id === ui.selQ) : null;
  if (ui.view === 'resp' && !q) ui.view = 'detail';
  if (ui.view === 'dash' || ui.view === 'list') m.innerHTML = dashHTML();
  else if (ui.view === 'detail') m.innerHTML = detailHTML(c);
  else if (ui.view === 'visit') m.innerHTML = visitHTML(c);
  else if (ui.view === 'resp') m.innerHTML = respHTML(c, q);
  else if (ui.view === 'new') m.innerHTML = newHTML();
  else if (ui.view === 'queue') m.innerHTML = queueHTML();
  else if (ui.view === 'cal') m.innerHTML = calHTML();
  else if (ui.view === 'ok') m.innerHTML = okHTML();
  bindMain();
}
function go(view, sel) { if (sel !== undefined) ui.sel = sel; if (view !== 'detail' || sel !== undefined) ui.tutte = false; ui.view = view; ui.confirmDel = null; renderBar(); renderList(); renderMain(); window.scrollTo({ top: 0 }); }

function setupHTML() {
  return `<div class="setup"><img src="logo.png" alt="Is Mellus" class="logo-big"><h1>Collega il dispositivo</h1>
  <p>Inserisci l'indirizzo del server e il tuo codice operatore. Li trovi nella guida di installazione: li dà Alberto. Serve farlo una volta sola, con la connessione attiva.</p>
  <form id="sf" novalidate style="margin-top:16px">
   <label>Indirizzo del server (finisce con /exec)<input type="url" id="s_url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg && cfg.url || '')}" autocomplete="off"></label>
   <label>Codice operatore<input type="password" id="s_tok" autocomplete="off"></label>
   <p class="err" id="s_err" hidden></p>
   <button class="btn primary" type="submit" id="s_go">Collega e scarica i clienti</button>
  </form></div>`;
}

/* ---------- dashboard ---------- */
// Le righe di una stessa quotazione (stessa visita) si contano come una quotazione sola
function gruppiQuot(cs) {
  const g = new Map();
  cs.forEach(c => c.quotAttesa.forEach(q => {
    const k = c.nome + '|' + (q.idVisita || q.data);
    if (!g.has(k)) g.set(k, { cliente: c.nome, data: q.data, righe: [], pend: false });
    const x = g.get(k); x.righe.push(q); x.pend = x.pend || !!q._pend;
  }));
  g.forEach(x => x.righe.sort(perRiga));
  return [...g.values()].sort((a, b) => String(a.data).localeCompare(String(b.data)));
}
function dashHTML() {
  const cs = clienti(), t = today(), t7 = addDays(t, 7), mese = t.slice(0, 7), op = me();
  const late = cs.filter(isLate).sort((a, b) => a.dataProssima.localeCompare(b.dataProssima));
  const soon = cs.filter(c => c.dataProssima && c.dataProssima >= t && c.dataProssima <= t7).sort((a, b) => a.dataProssima.localeCompare(b.dataProssima));
  const vis = cs.flatMap(c => c.visite.map(v => ({ ...v, cliente: c.nome }))).sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.creata || '').localeCompare(String(a.creata || '')));
  const visMese = vis.filter(v => String(v.data).startsWith(mese));
  const qg = gruppiQuot(cs);
  const samp = cs.reduce((n, c) => n + c.samplesAperti.length, 0);
  const acc = s => cs.filter(c => c.account === s).length;
  const kpi = (n, label, f, alert) => f ? `<button type="button" class="kpi${alert && n ? ' alert' : ''}" data-filter="${f}"><b>${n}</b><span>${label}</span></button>` : `<div class="kpi"><b>${n}</b><span>${label}</span></div>`;
  const riga = (nome, sopra, sotto, destra, cls) => `<li><button type="button" class="rlink" data-n="${esc(nome)}"><span class="cname">${esc(nome)}</span><span class="${cls || 'when'}">${destra}</span><span class="csub">${sopra}${sotto ? ' · ' + sotto : ''}</span></button></li>`;
  const vuoto = t => `<p class="empty">${t}</p>`;
  const ora = new Date().getHours();
  return `<div class="dash-head"><div><h1>${ora < 13 ? 'Buongiorno' : ora < 18 ? 'Buon pomeriggio' : 'Buonasera'}${op ? ', ' + esc(op) : ''}</h1>
   <div class="meta">${new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
   <div class="d-actions"><button class="btn" type="button" data-act="cal">Calendario</button><button class="btn" type="button" data-act="list">Tutti i clienti</button><button class="btn primary" type="button" data-act="new">+ Nuovo cliente</button></div></div>
  ${pendingCount() ? `<div class="msg warn">Hai ${pendingCount()} ${pendingCount() === 1 ? 'elemento' : 'elementi'} da inviare. Sincronizza a fine giornata, con il Wi-Fi o la rete mobile.</div>` : ''}
  <div class="kpis">
   ${kpi(late.length, 'Follow-up scaduti', 'late', true)}
   ${kpi(soon.length, 'Follow-up nei prossimi 7 giorni', 'soon')}
   ${kpi(qg.length, 'Quotazioni in attesa di risposta', 'quot')}
   ${kpi(visMese.length, `Visite questo mese${op ? ` · ${visMese.filter(v => v.op === op).length} tue` : ''}`)}
   ${kpi(samp, 'Samples senza feedback')}
   ${kpi(cs.length, `Clienti · ${acc('SI')} account SI · ${acc('BSS')} BSS`, 'all')}
  </div>
  <div class="dgrid">
   <section><h2>Follow-up scaduti</h2>${late.length ? `<ul class="dl">${late.slice(0, 8).map(c => riga(c.nome, esc(c.prossimaAzione || 'Nessuna azione'), '', `${fmt(c.dataProssima)} · ${giorni(c.dataProssima)} gg`, 'when late')).join('')}</ul>${late.length > 8 ? `<button class="btn ghost" type="button" data-filter="late">Vedi tutti (${late.length})</button>` : ''}` : vuoto('Nessun follow-up scaduto.')}</section>
   <section><h2>Prossimi 7 giorni</h2>${soon.length ? `<ul class="dl">${soon.slice(0, 8).map(c => riga(c.nome, esc(c.prossimaAzione || ''), '', fmt(c.dataProssima))).join('')}</ul>` : vuoto('Nessun follow-up in programma.')}</section>
   <section><h2>Quotazioni in attesa di risposta</h2>${qg.length ? `<ul class="dl">${qg.slice(0, 8).map(x => riga(x.cliente, `${x.righe.length} ${x.righe.length === 1 ? 'prodotto' : 'prodotti'}: ${esc(x.righe.slice(0, 3).map(q => q.prodotto).join(', '))}${x.righe.length > 3 ? '…' : ''}`, x.pend ? '<span class="tag">da inviare</span>' : '', `${fmt(x.data)} · ${giorni(x.data)} gg`)).join('')}</ul>` : vuoto('Nessuna quotazione in attesa.')}</section>
   <section><h2>Ultime visite</h2>${vis.length ? `<ul class="dl">${vis.slice(0, 8).map(v => riga(v.cliente, `${esc(v.tipo || '')}${v.contatto ? ' con ' + esc(v.contatto) : ''}${v.op ? ' · ' + esc(v.op) : ''}`, v.esitoVisita ? pillT(v.esitoVisita) : '', fmt(v.data))).join('')}</ul>` : vuoto('Nessuna visita registrata.')}</section>
  </div>`;
}

/* ---------- calendario: follow-up (prossima azione) e visite fatte ---------- */
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
function calHTML() {
  const t = today(), mese = ui.calMese || t.slice(0, 7), sel = ui.calGiorno || t;
  const cs = clienti(), giorni = {};
  const g = d => (giorni[d] = giorni[d] || { follow: [], visite: [] });
  cs.forEach(c => {
    if (c.dataProssima) g(c.dataProssima).follow.push(c);
    c.visite.forEach(v => { if (v.data) g(String(v.data).slice(0, 10)).visite.push({ c, v }); });
  });
  const [y, m] = mese.split('-').map(Number);
  const primo = new Date(y, m - 1, 1), offset = (primo.getDay() + 6) % 7; // lunedì = 0
  const inizio = new Date(y, m - 1, 1 - offset);
  const celle = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(inizio.getFullYear(), inizio.getMonth(), inizio.getDate() + i), iso = isoDay(d), x = giorni[iso] || { follow: [], visite: [] };
    if (i >= 35 && d.getMonth() !== m - 1) break;
    const scad = x.follow.length && iso < t;
    celle.push(`<button type="button" class="cday${d.getMonth() !== m - 1 ? ' out' : ''}${iso === t ? ' today' : ''}" data-day="${iso}" aria-pressed="${iso === sel}" aria-label="${d.getDate()} ${MESI[d.getMonth()]}: ${x.follow.length} follow-up, ${x.visite.length} visite">
      <span class="n">${d.getDate()}</span>${x.follow.length ? `<span class="badge ${scad ? 'b-l' : 'b-f'}">${x.follow.length}<i> follow-up</i></span>` : ''}${x.visite.length ? `<span class="badge b-v">${x.visite.length}<i> ${x.visite.length === 1 ? 'visita' : 'visite'}</i></span>` : ''}</button>`);
  }
  const x = giorni[sel] || { follow: [], visite: [] };
  const late = cs.filter(isLate).length;
  const riga = (nome, sopra, destra, cls) => `<li><button type="button" class="rlink" data-n="${esc(nome)}"><span class="cname">${esc(nome)}</span><span class="${cls || 'when'}">${destra}</span><span class="csub">${sopra}</span></button></li>`;
  const dataLunga = new Date(sel + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  return `<div class="navrow"><button class="btn ghost" type="button" data-act="dash">← Dashboard</button></div>
  <div class="dash-head"><div><h1>Calendario</h1><div class="meta">Follow-up (prossima azione dei clienti) e visite registrate</div></div>
   <div class="d-actions"><button class="btn" type="button" data-calnav="-1" aria-label="Mese precedente">‹</button><button class="btn" type="button" data-calnav="0">Oggi</button><button class="btn" type="button" data-calnav="1" aria-label="Mese successivo">›</button></div></div>
  ${late ? `<button type="button" class="msg err linkmsg" data-filter="late">${late} follow-up scaduti da recuperare: vedi l'elenco</button>` : ''}
  <h2 class="calmese">${MESI[m - 1]} ${y}</h2>
  <div class="calgrid" role="grid"><span>Lun</span><span>Mar</span><span>Mer</span><span>Gio</span><span>Ven</span><span>Sab</span><span>Dom</span>${celle.join('')}</div>
  <div class="legenda"><span class="badge b-f">follow-up</span><span class="badge b-l">scaduto</span><span class="badge b-v">visite fatte</span></div>
  <section><h2>${esc(dataLunga)}</h2>
   ${x.follow.length ? `<h3 class="sub">Follow-up</h3><ul class="dl">${x.follow.map(c => riga(c.nome, esc(c.prossimaAzione || '') + (c.priorita ? ' · priorità ' + esc(c.priorita) : ''), isLate(c) ? 'scaduto' : '', 'when late')).join('')}</ul>` : ''}
   ${x.visite.length ? `<h3 class="sub">Visite</h3><ul class="dl">${x.visite.map(({ c, v }) => riga(c.nome, `${esc(v.tipo || '')}${v.contatto ? ' con ' + esc(v.contatto) : ''}${v.op ? ' · ' + esc(v.op) : ''} ${pillT(v.esitoVisita)}${v._pend ? ' <span class="tag">da inviare</span>' : ''}`, '')).join('')}</ul>` : ''}
   ${!x.follow.length && !x.visite.length ? '<p class="empty">Niente in programma in questo giorno.</p>' : ''}
  </section>`;
}

/* ---------- scheda cliente con storico ---------- */
const MOSTRA_RIGHE = 5;
function quotTable(qs, conRisposta, titolo) {
  if (!qs.length) return '';
  const tr = q => `<tr>
    <td>${esc(q.prodotto)}${q.codice ? ` <span class="muted">${esc(q.codice)}</span>` : ''}${q.nota ? `<div class="muted small">${esc(q.nota)}</div>` : ''}</td><td>${esc(q.fmt || '')}</td>
    <td class="num">${money(q.listino)}</td><td class="num">${money(q.offerto)}</td><td class="num">${pct(q.sconto)}</td>
    <td>${pillT(q.stato || 'Inviata')}${q._pendR ? '<span class="tag">da inviare</span>' : ''}${q.valida ? `<div class="muted small">valida al ${fmt(q.valida)}</div>` : ''}</td>
    ${conRisposta ? `<td><button class="btn small" type="button" data-q="${esc(q.id)}">Risposta</button></td>` : ''}</tr>`;
  const head = `<thead><tr><th>Prodotto</th><th>Formato</th><th class="num">Listino</th><th class="num">Offerto</th><th class="num">Sconto</th><th>Stato</th>${conRisposta ? '<th></th>' : ''}</tr></thead>`;
  const tab = righe => `<div class="tblwrap"><table class="qt">${head}<tbody>${righe.map(tr).join('')}</tbody></table></div>`;
  const stati = [...new Set(qs.map(q => q.stato || 'Inviata'))];
  const riass = `${qs.length} ${qs.length === 1 ? 'riga' : 'righe'} · ${stati.map(pillT).join(' ')}`;
  if (qs.length <= MOSTRA_RIGHE) return (titolo ? `<h3>${titolo} · ${riass}</h3>` : '') + tab(qs);
  return `<details class="qdet"><summary>${titolo ? titolo + ' · ' : ''}${riass} <span class="muted">— tocca per vedere le righe</span></summary>${tab(qs)}</details>`;
}
const rispostaTutta = righe => righe.length > 1 ? `<button class="btn small" type="button" data-q="${esc(righe[0].id)}" data-all="1">Risposta a tutta la quotazione</button>` : '';
function visitaHTML(v, c) {
  const qs = c.quot.filter(q => q.idVisita && q.idVisita === v.id).sort(perRiga);
  const sm = c.samples.filter(s => s.idVisita && s.idVisita === v.id).slice().reverse();
  return `<article class="vcard${v._pend ? ' pend' : ''}">
   <div class="vhead"><span class="t-d">${fmt(v.data)} · ${esc(v.tipo || '')}${v.op ? ' · ' + esc(v.op) : ''}</span>${pillT(v.esitoVisita)}${v._pend ? `<span class="tag${v._err ? ' err' : ''}">${v._err ? 'errore' : 'da inviare'}</span>` : ''}</div>
   ${v.contatto ? `<div class="vwho">Con <b>${esc(v.contatto)}</b>${(c.contatti.find(k => k.nome === v.contatto) || {}).ruolo ? ` <span class="muted">· ${esc(c.contatti.find(k => k.nome === v.contatto).ruolo)}</span>` : ''}</div>` : ''}
   <div class="t-x">${esc(v.esito || '')}</div>
   ${v.prodotti ? `<div class="small"><span class="muted">Prodotti discussi:</span> ${esc(v.prodotti)}</div>` : ''}
   ${qs.length ? `<div class="vsub">${quotTable(qs, true, 'Quotazione del giorno')}${rispostaTutta(qs)}</div>` : ''}
   ${sm.length ? `<div class="vsub"><h3>Samples lasciati</h3><div class="contacts">${sm.map(s => `<div>${esc(s.prodotto)}${s.qty ? ' ×' + esc(s.qty) : ''} ${pillT(s.feedback || 'In attesa')}</div>`).join('')}</div></div>` : ''}
   ${v.step ? `<div class="vnext">→ ${esc(v.step)}${v.follow ? ` <span class="when">entro ${fmt(v.follow)}</span>` : ''}</div>` : ''}
  </article>`;
}
function detailHTML(c) {
  const vis = ui.tutte ? c.visite : c.visite.slice(0, CONFIG.visiteMostrate);
  const idsVisite = new Set(c.visite.map(v => v.id));
  const altre = c.quot.filter(q => !q.idVisita || !idsVisite.has(q.idVisita));
  const attesa = gruppiQuot([c]);
  return `<div class="navrow"><button class="btn ghost" type="button" data-act="dash">← Dashboard</button><button class="btn ghost back" type="button" data-act="list">← Clienti</button></div>
  ${c._err ? `<div class="msg err">Il cliente non è stato creato sul foglio: ${esc(c._err)}</div>` : ''}
  <div class="d-head"><div><h1>${esc(c.nome)}${c._pend ? '<span class="tag">nuovo · da inviare</span>' : ''}</h1><div class="meta">${esc([c.tipologia, c.canale, c.zona, c.sales && 'Sales: ' + c.sales].filter(Boolean).join(' · ') || 'Anagrafica da completare')}</div>
  <div class="meta">${badgeSV(c)} ${ultimaInt(c) ? 'Ultima interazione ' + fmt(ultimaInt(c)) : 'Nessuna visita registrata'}</div></div>
  <button class="btn primary" type="button" data-act="visit">Registra visita</button></div>
  <div class="status"><div class="st"><span>Quotation</span>${pill(c.quotation)}</div><div class="st"><span>Food testing</span>${pill(c.foodtesting)}</div><div class="st"><span>Account</span>${pill(c.account)}</div></div>
  <div class="next"><div><h2 style="margin:0 0 4px">Prossima azione${c.priorita ? ' · priorità ' + esc(c.priorita) : ''}</h2>${c.prossimaAzione ? esc(c.prossimaAzione) : '<span class="empty">Non impostata</span>'}</div><div class="when ${isLate(c) ? 'late' : ''}">${c.dataProssima ? fmt(c.dataProssima) + (isLate(c) ? ' · scaduta' : '') : ''}</div></div>
  ${c.note ? `<div><h2>Note / stato attuale</h2><div class="note">${esc(c.note)}</div></div>` : ''}
  <div class="two">
   <div><h2>Contatti</h2><div class="contacts">${c.contatti.map(k => `<div>${esc(k.nome)}${k.ruolo ? ` <span>· ${esc(k.ruolo)}</span>` : ''}</div>`).join('') || '<span class="empty">Nessun contatto</span>'}</div></div>
   <div><h2>Samples senza feedback</h2>${c.samplesAperti.length ? `<div class="contacts">${c.samplesAperti.map(s => `<div>${esc(s.prodotto)}${s.qty ? ' ×' + esc(s.qty) : ''} <span>· ${fmt(s.data)}</span></div>`).join('')}</div>` : '<p class="empty">Nessuno.</p>'}</div>
  </div>
  ${attesa.length ? `<section><h2>Quotazioni in attesa di risposta</h2>${attesa.map(x => `<div class="qgroup">${quotTable(x.righe, true, `Del ${fmt(x.data)} · ${giorni(x.data)} gg fa`)}${rispostaTutta(x.righe)}</div>`).join('')}</section>` : ''}
  <section><h2>Storico visite (${c.visite.length})</h2>
   ${vis.length ? `<div class="vlist">${vis.map(v => visitaHTML(v, c)).join('')}</div>` : '<p class="empty">Nessuna visita registrata.</p>'}
   ${!ui.tutte && c.visite.length > vis.length ? `<button class="btn" type="button" id="showAll">Mostra tutte le visite (${c.visite.length})</button>` : ''}
  </section>
  ${altre.length ? `<section><h2>Altre quotazioni</h2>${quotTable(altre.slice().sort(perRiga), true, 'Senza visita collegata')}</section>` : ''}
  <p class="meta">Storico completo anche nel foglio Google, foglio <b>STORICO CLIENTE</b>.</p>`;
}
function respHTML(c, q) {
  const stessa = c.quot.filter(x => q.idVisita && x.idVisita === q.idVisita);
  return `<button class="btn ghost" type="button" data-act="detail" style="align-self:flex-start">← ${esc(c.nome)}</button>
  <div><h1>Risposta del cliente</h1><div class="meta">${esc(c.nome)} · quotazione del ${fmt(q.data)}</div></div>
  ${ui.respTutte && stessa.length > 1 ? `<p class="meta">Quotazione di ${stessa.length} righe: ${esc(stessa.slice(0, 4).map(x => x.prodotto).join(', '))}${stessa.length > 4 ? '…' : ''}</p>` : quotTable([q], false)}
  <form id="rf" novalidate>
   <fieldset>
    <label>Stato della quotazione<select id="r_stato">${opts(lista('Stato quotazione'), q.stato || 'Inviata')}</select></label>
    <label>Risposta / note<textarea id="r_nota" placeholder="es. Accettato il prezzo, primo ordine la prossima settimana">${esc(q.nota || '')}</textarea></label>
    <label>Valida fino a<input type="date" id="r_valida" value="${esc(q.valida || '')}"></label>
    ${stessa.length > 1 ? `<label class="check"><input type="checkbox" id="r_tutte"${ui.respTutte ? ' checked' : ''}> Applica a tutte le ${stessa.length} righe di questa quotazione</label>` : ''}
   </fieldset>
   <p class="err" id="r_err" hidden></p>
   <div class="actions"><button class="btn" type="button" data-act="detail">Annulla</button><button class="btn primary" type="submit">Salva risposta</button></div>
  </form>`;
}
const seg = (name, val, vals) => `<div class="seg" role="group" data-seg="${name}" data-orig="${esc(val || '')}">${vals.map(v => `<button type="button" data-v="${v}" aria-pressed="${v === val}">${v}</button>`).join('')}</div>`;
const R = req => req ? ' <span class="req">*</span>' : '';
function visitHTML(c) {
  const ob = CONFIG.obbligatori;
  return `<div class="navrow"><button class="btn ghost" type="button" data-act="dash">← Dashboard</button><button class="btn ghost" type="button" data-act="detail">← ${esc(c.nome)}</button></div>
  <div><h1>Nuova visita</h1><div class="meta">${esc(c.nome)} · ${esc(me())}</div></div>
  <form id="vf" novalidate>
   <fieldset><legend>La visita</legend>
    <div class="row c2"><label>Data${R(1)}<input type="date" id="v_data" value="${today()}"></label>
    <label>Tipo<select id="v_tipo">${opts(lista('Tipo visita'), 'Visita')}</select></label></div>
    <label>Con chi (contatto incontrato)<select id="v_cont">${opts(c.contatti.map(k => k.nome).concat(['Altro / nuovo contatto']), c.contatti[0] && c.contatti[0].nome)}</select></label>
    <div class="row c2" id="v_newcont" hidden><label>Nome nuovo contatto<input type="text" id="v_nc_nome"></label><label>Ruolo<input type="text" id="v_nc_ruolo" placeholder="es. executive chef"></label></div>
    <label>Di cosa si è parlato${R(ob.esito)}<textarea id="v_esito" placeholder="Argomenti, richieste, cosa ha detto il cliente"></textarea></label>
    <label>Prodotti discussi<input type="text" id="v_prod" placeholder="es. Pecorino Sardo DOP, Bottarga"></label>
    <label>Esito della visita${R(ob.esitoVisita)}${seg('esitoVisita', '', lista('Esito visita'))}</label>
   </fieldset>
   ${c.samplesAperti.length ? `<fieldset><legend>Feedback sui samples lasciati</legend>${c.samplesAperti.map(s => `<div class="fbrow"><div>${esc(s.prodotto)}${s.qty ? ' ×' + esc(s.qty) : ''} <span class="t-d">· ${fmt(s.data)}</span></div><select data-fb="${esc(s.id)}" aria-label="Feedback ${esc(s.prodotto)}"><option value="">Nessun feedback</option>${opts(lista('Feedback samples').filter(x => x !== 'In attesa'))}</select></div>`).join('')}</fieldset>` : ''}
   <fieldset><legend>Samples lasciati oggi</legend><div id="samples"></div><button class="btn" type="button" id="addS">+ Aggiungi sample</button></fieldset>
   <fieldset><legend>Quotazione / prezzi <span class="count" id="qcount"></span></legend>
    <div class="row c2"><label>Stato della quotazione<select id="q_stato">${opts(lista('Stato quotazione'), 'Inviata')}</select></label><label>Valida fino a<input type="date" id="q_valida"></label></div>
    <div id="quots"></div>
    <div class="btnrow"><button class="btn" type="button" id="addQ">+ Aggiungi riga</button><button class="btn" type="button" id="addQ5">+ 5 righe</button></div>
   </fieldset>
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
const quotRow = () => `<div class="qrow"><span class="qn"></span><label>Prodotto<input type="text" data-k="prod"></label><label>Codice<input type="text" data-k="cod"></label><label>Formato<input type="text" data-k="fmt" placeholder="kg, 6×1kg"></label><label>Listino AED<input type="number" step="0.01" min="0" inputmode="decimal" data-k="list"></label><label>Offerto AED<input type="number" step="0.01" min="0" inputmode="decimal" data-k="off"></label><div class="disc" data-disc>—</div><button class="btn ghost x2" type="button" data-del aria-label="Rimuovi riga">✕</button></div>`;
function newHTML() {
  return `<div class="navrow"><button class="btn ghost" type="button" data-act="dash">← Dashboard</button></div>
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
   <div class="actions"><button class="btn" type="button" data-act="dash">Annulla</button><button class="btn primary" type="submit">Crea e registra visita</button></div>
  </form>`;
}
function queueHTML() {
  const item = (tipo, x, titolo, sotto) => `<div class="qitem"><div class="t-x"><div class="t-d">${tipo}${x._errore ? '<span class="tag err">errore</span>' : ''}</div><b>${esc(titolo)}</b><div>${esc(sotto)}</div>${x._errore ? `<p class="err">${esc(x._errore)}</p>` : ''}</div>
   <button class="btn ${ui.confirmDel === x.id ? 'danger' : 'ghost'}" type="button" data-qdel="${esc(x.id)}">${ui.confirmDel === x.id ? 'Conferma: elimina' : 'Elimina'}</button></div>`;
  const all = [
    ...queue.nuoviClienti.map(x => item('Nuovo cliente', x, x.nome, [x.tipologia, x.zona].filter(Boolean).join(' · '))),
    ...queue.visite.map(x => item(`Visita del ${fmt(x.data)}${x.quot && x.quot.length ? ` · ${x.quot.length} righe di quotazione` : ''}`, x, x.cliente, x.esito)),
    ...queue.feedback.map(x => item('Feedback sample', x, x.prodotto || x.id, x.feedback)),
    ...queue.risposte.map(x => item('Risposta a quotazione', x, x.cliente || '', `${x.prodotto || ''}: ${x.stato}${x.nota ? ' · ' + x.nota : ''}`)),
  ];
  return `<div class="navrow"><button class="btn ghost" type="button" data-act="dash">← Dashboard</button></div>
  <div><h1>Da inviare</h1><div class="meta">Salvati su questo dispositivo, non ancora sul foglio Google</div></div>
  ${all.length ? all.join('') : '<p class="empty">Niente da inviare: il foglio è aggiornato.</p>'}
  <div class="actions" style="position:static"><button class="btn" type="button" id="copyQ">Copia dati in sospeso</button><button class="btn primary" type="button" data-act="sync">Sincronizza ora</button></div>
  <textarea id="copyArea" hidden readonly style="min-height:160px;font-family:var(--f-mono);font-size:12px"></textarea>
  <div><h2>Dispositivo</h2><p class="meta">Server: <code>${esc(cfg.url)}</code></p><p class="meta">Operatore: ${esc(me() || '—')}</p>
  <button class="btn ${ui.confirmDel === '__logout' ? 'danger' : ''}" type="button" id="logout">${ui.confirmDel === '__logout' ? (pendingCount() ? `Attenzione: ${pendingCount()} elementi non inviati andranno persi. Conferma` : 'Conferma scollegamento') : 'Scollega questo dispositivo'}</button></div>`;
}
function okHTML() {
  const i = ui.okInfo || {};
  const inCoda = queue.visite.some(v => v.id === i.id) || queue.risposte.some(r => (i.ids || []).includes(r.id));
  return `<div><h1 style="color:var(--si)">${esc(i.titolo || 'Visita salvata')}</h1><div class="meta">${esc(i.cliente || '')}</div></div>
  <div class="msg ${!inCoda ? 'ok' : navigator.onLine ? 'info' : 'warn'}">${!inCoda ? 'Inviata e scritta sul foglio.' : syncing ? 'Salvata sul dispositivo. Invio al foglio in corso…' : navigator.onLine ? 'Salvata sul dispositivo. Verrà inviata alla prossima sincronizzazione.' : 'Salvata sul dispositivo. Sei offline: verrà inviata al foglio alla prossima sincronizzazione.'}</div>
  <div class="actions" style="position:static;border:0"><button class="btn" type="button" data-act="detail">Apri scheda cliente</button><button class="btn primary" type="button" data-act="dash">Torna alla dashboard</button></div>`;
}

/* ---------- eventi ---------- */
function apriFiltro(f) { ui.filter = f; ui.q = ''; $('#q').value = ''; go('list'); if (window.matchMedia('(min-width:900px)').matches) $('#list').scrollTop = 0; }
function bindMain() {
  document.querySelectorAll('#main [data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'sync') sync(true);
    else if (a === 'new') openNew();
    else if (a === 'list') { if (ui.filter !== 'all') ui.filter = 'all'; go('list'); }
    else go(a);
  });
  document.querySelectorAll('#main [data-filter]').forEach(b => b.onclick = () => apriFiltro(b.dataset.filter));
  document.querySelectorAll('#main [data-n]').forEach(b => b.onclick = () => go('detail', b.dataset.n));
  document.querySelectorAll('#main [data-q]').forEach(b => b.onclick = () => { ui.selQ = b.dataset.q; ui.respTutte = !!b.dataset.all; go('resp'); });
  document.querySelectorAll('#main [data-day]').forEach(b => b.onclick = () => { ui.calGiorno = b.dataset.day; if (b.dataset.day.slice(0, 7) !== (ui.calMese || today().slice(0, 7))) ui.calMese = b.dataset.day.slice(0, 7); renderMain(); });
  document.querySelectorAll('#main [data-calnav]').forEach(b => b.onclick = () => {
    const n = +b.dataset.calnav;
    if (!n) { ui.calMese = today().slice(0, 7); ui.calGiorno = today(); }
    else { const [y, m] = (ui.calMese || today().slice(0, 7)).split('-').map(Number); const d = new Date(y, m - 1 + n, 1); ui.calMese = isoDay(d).slice(0, 7); ui.calGiorno = isoDay(d); }
    renderMain();
  });
  const sa = $('#showAll'); if (sa) sa.onclick = () => { ui.tutte = true; renderMain(); };
  document.querySelectorAll('#main .seg').forEach(s => s.onclick = e => { const b = e.target.closest('button'); if (!b) return; const was = b.getAttribute('aria-pressed') === 'true'; s.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', !was && x === b)); });
  const sf = $('#sf'); if (sf) sf.onsubmit = e => { e.preventDefault(); connect(); };
  const vf = $('#vf');
  if (vf) {
    const cont = $('#v_cont'), upd = () => $('#v_newcont').hidden = cont.value !== 'Altro / nuovo contatto';
    cont.onchange = upd; upd();
    const numera = () => { const r = [...document.querySelectorAll('#quots .qrow')]; r.forEach((x, i) => x.querySelector('.qn').textContent = i + 1); $('#qcount').textContent = r.length ? `· ${r.length} ${r.length === 1 ? 'riga' : 'righe'}` : ''; };
    const add = (id, html, n = 1, focus = true) => { let first; for (let i = 0; i < n; i++) { const w = document.createElement('div'); w.innerHTML = html; const el = w.firstChild; $(id).appendChild(el); first = first || el; } numera(); if (focus) first.querySelector('input').focus(); };
    $('#addS').onclick = () => add('#samples', sampleRow());
    $('#addQ').onclick = () => add('#quots', quotRow());
    $('#addQ5').onclick = () => add('#quots', quotRow(), 5);
    vf.addEventListener('click', e => { if (e.target.closest('[data-del]')) { (e.target.closest('.rep') || e.target.closest('.qrow')).remove(); numera(); } });
    vf.addEventListener('input', e => { const r = e.target.closest('.qrow'); if (!r) return; const l = +r.querySelector('[data-k=list]').value, o = +r.querySelector('[data-k=off]').value; r.querySelector('[data-disc]').textContent = l > 0 && o > 0 ? `−${Math.round((1 - o / l) * 1000) / 10}%` : '—'; });
    vf.onsubmit = e => { e.preventDefault(); saveVisit(); };
  }
  const rf = $('#rf'); if (rf) rf.onsubmit = e => { e.preventDefault(); saveResp(); };
  const nf = $('#nf');
  if (nf) {
    const chk = () => { const s = similar($('#n_nome').value); $('#n_dup').hidden = !s.length; $('#n_dup').innerHTML = s.length ? `Esiste già un cliente simile: <b>${s.map(esc).join(', ')}</b>. Controlla prima di crearne uno nuovo.` : ''; };
    $('#n_nome').oninput = chk; chk();
    nf.onsubmit = e => { e.preventDefault(); saveNew(); };
  }
  document.querySelectorAll('#main [data-qdel]').forEach(b => b.onclick = () => {
    const id = b.dataset.qdel;
    if (ui.confirmDel !== id) { ui.confirmDel = id; renderMain(); return; }
    LISTE_CODA.forEach(l => queue[l] = queue[l].filter(x => x.id !== id));
    saveQueue(); ui.confirmDel = null; renderBar(); renderList(); renderMain();
  });
  const cq = $('#copyQ');
  if (cq) cq.onclick = async () => {
    const txt = JSON.stringify({ esportato: new Date().toISOString(), operatore: me(), ...queue }, null, 1);
    const ta = $('#copyArea'); ta.value = txt; ta.hidden = false;
    try { await navigator.clipboard.writeText(txt); flash('ok', 'Dati copiati. Incollali in una email o in WhatsApp ad Alberto.'); }
    catch (e) { ta.focus(); ta.select(); flash('info', 'Testo selezionato qui sotto: copialo a mano.'); }
  };
  const lo = $('#logout');
  if (lo) lo.onclick = () => {
    if (ui.confirmDel !== '__logout') { ui.confirmDel = '__logout'; renderMain(); return; }
    ['rv_cfg', 'rv_data', 'rv_queue'].forEach(k => { try { localStorage.removeItem(k); } catch (e) { } });
    cfg = null; data = null; queue = codaVuota(); ui = { ...ui, sel: null, view: 'dash', confirmDel: null };
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
  go('visit', nome);
}

function saveVisit() {
  const c = clienti().find(x => x.nome === ui.sel), err = $('#v_err'), ob = CONFIG.obbligatori;
  const g = id => $(id).value.trim();
  const fail = (t, id) => { err.hidden = false; err.textContent = t; if (id) { $(id).focus(); $(id).scrollIntoView({ block: 'center' }); } };
  const segVal = name => { const s = $(`#vf .seg[data-seg="${name}"]`); const b = s && s.querySelector('[aria-pressed=true]'); return b ? b.dataset.v : ''; };
  if (!g('#v_data')) return fail('Inserisci la data della visita.', '#v_data');
  if (ob.esito && !g('#v_esito')) return fail('Scrivi di cosa si è parlato.', '#v_esito');
  if (ob.esitoVisita && !segVal('esitoVisita')) { fail('Scegli l\'esito della visita.'); $('#vf .seg[data-seg="esitoVisita"]').scrollIntoView({ block: 'center' }); return; }
  if (ob.step && !g('#v_step')) return fail('Scrivi la prossima azione: senza, il cliente sparisce dai follow-up.', '#v_step');
  if (ob.follow && !g('#v_follow')) return fail('Inserisci la data del follow-up.', '#v_follow');
  const nuovo = $('#v_cont').value === 'Altro / nuovo contatto';
  if (nuovo && !g('#v_nc_nome')) return fail('Scrivi il nome del nuovo contatto o scegline uno dalla lista.', '#v_nc_nome');
  const rows = sel => [...document.querySelectorAll(sel)].map(r => Object.fromEntries([...r.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value.trim()]))).filter(o => o.prod);
  const qStato = $('#q_stato').value, qValida = $('#q_valida').value;
  const quot = rows('#quots .qrow').map(q => ({ ...q, stato: qStato, valida: qValida }));
  const stato = {};
  ['quotation', 'foodtesting', 'account'].forEach(n => { const s = $(`#vf .seg[data-seg="${n}"]`), v = segVal(n); if (v && v !== s.dataset.orig) stato[n] = v; });
  const prio = $('#v_prio'), note = $('#v_note');
  const v = {
    id: uid(), creata: new Date().toISOString(), cliente: c.nome, data: g('#v_data'), tipo: $('#v_tipo').value,
    contatto: nuovo ? g('#v_nc_nome') : $('#v_cont').value, nuovoContatto: nuovo ? { nome: g('#v_nc_nome'), ruolo: g('#v_nc_ruolo') } : null,
    esito: g('#v_esito'), prodotti: g('#v_prod'), esitoVisita: segVal('esitoVisita'), samples: rows('#samples .rep'), quot, stato,
    step: g('#v_step'), follow: g('#v_follow'),
  };
  if (prio.value && prio.value !== prio.dataset.orig) v.priorita = prio.value;
  if (note.value.trim() !== (note.dataset.orig || '').trim()) v.note = note.value.trim();
  const fb = [...document.querySelectorAll('#vf [data-fb]')].filter(s => s.value).map(s => ({ id: s.dataset.fb, feedback: s.value, prodotto: s.closest('.fbrow').firstElementChild.textContent.split('·')[0].trim(), cliente: c.nome }));
  queue.visite.push(v); queue.feedback.push(...fb);
  if (!saveQueue()) { queue.visite.pop(); queue.feedback.splice(queue.feedback.length - fb.length, fb.length); return; }
  ui.okInfo = { cliente: c.nome, id: v.id, titolo: 'Visita salvata' };
  go('ok');
  if (navigator.onLine) sync(false);
}

function saveResp() {
  const c = clienti().find(x => x.nome === ui.sel), q = c && c.quot.find(x => x.id === ui.selQ);
  if (!q) return go('detail');
  const tutte = $('#r_tutte') && $('#r_tutte').checked;
  const righe = tutte ? c.quot.filter(x => x.idVisita === q.idVisita) : [q];
  const creata = new Date().toISOString(), stato = $('#r_stato').value, nota = $('#r_nota').value.trim(), valida = $('#r_valida').value;
  const nuove = righe.map(x => ({ id: uid(), quot: x.id, stato, nota, valida, creata, cliente: c.nome, prodotto: x.prodotto }));
  queue.risposte.push(...nuove);
  if (!saveQueue()) { queue.risposte.splice(queue.risposte.length - nuove.length, nuove.length); return; }
  ui.okInfo = { cliente: c.nome, ids: nuove.map(r => r.id), titolo: nuove.length > 1 ? `Risposta salvata su ${nuove.length} righe` : 'Risposta salvata' };
  go('ok');
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
    ui.view = 'dash'; render();
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
  const body = {
    nuoviClienti: queue.nuoviClienti.map(strip), visite: queue.visite.map(strip),
    feedback: queue.feedback.map(({ prodotto, cliente, ...f }) => strip(f)),
    risposte: queue.risposte.map(({ prodotto, cliente, ...r }) => strip(r)),
  };
  const n = pendingCount();
  try {
    const j = await post(body);
    let ok = 0, ko = 0; const avvisi = [];
    if (j.risultati) {
      const done = new Set(), errs = {};
      ['clienti', 'visite', 'feedback', 'risposte'].forEach(l => (j.risultati[l] || []).forEach(r => {
        if (FATTO.includes(r.esito)) { done.add(r.id); ok++; if (r.avviso && !avvisi.includes(r.avviso)) avvisi.push(r.avviso); }
        else { errs[r.id] = r.errore || 'Errore sconosciuto'; ko++; }
      }));
      LISTE_CODA.forEach(l => { queue[l] = queue[l].filter(x => !done.has(x.id)).map(x => errs[x.id] ? { ...x, _errore: errs[x.id] } : x); });
      saveQueue();
    }
    data = { ...j.dati, operatore: j.operatore, syncedAt: new Date().toISOString() };
    if (!store.set(K.data, data)) flash('warn', 'Memoria del dispositivo quasi piena: i dati del foglio non sono stati salvati per l\'uso offline.');
    const rimasti = pendingCount();
    if (ko) flash('err', `Inviati ${ok}, ${ko} non inviati: apri <b>Da inviare</b> per vedere il motivo.`);
    else if (n && rimasti) flash('warn', `Inviati ${ok}. ${rimasti} elementi non sono stati elaborati dal server: è ancora alla versione precedente? Avvisa Alberto.`);
    else if (n) flash('ok', `Sincronizzazione completata: ${ok} ${ok === 1 ? 'elemento inviato' : 'elementi inviati'} al foglio.${avvisi.length ? ' ' + esc(avvisi.join(' ')) : ''}`);
    else if (manual) flash('ok', 'Dati aggiornati dal foglio.');
  } catch (e) {
    flash('err', `Sincronizzazione non riuscita: ${esc(e.message)} I dati restano salvati sul dispositivo.`);
  } finally {
    syncing = false;
    renderBar(); renderList(); if (!['visit', 'new', 'resp'].includes(ui.view)) renderMain();
  }
}

function render() { renderBar(); renderList(); renderMain(); }

/* ---------- avvio ---------- */
$('#q').oninput = e => { ui.q = e.target.value; renderList(); };
$('#newBtn').onclick = openNew;
document.querySelectorAll('.chip').forEach(ch => ch.onclick = () => { ui.filter = ch.dataset.f; renderList(); });
$('#sort').innerHTML = Object.entries(ORDINI).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
$('#sort').value = ui.sort;
$('#sort').onchange = e => { ui.sort = e.target.value; store.set(K.sort, ui.sort); renderList(); };
$('#list').onclick = e => { const b = e.target.closest('button[data-n]'); if (b) go('detail', b.dataset.n); else if (e.target.closest('[data-act=new]')) openNew(); };
$('#syncBtn').onclick = () => sync(true);
$('#queueBtn').onclick = () => go('queue');
$('#brandBtn').onclick = () => { if (cfg) go('dash'); };
document.querySelectorAll('#tabs [data-nav]').forEach(b => b.onclick = () => go(b.dataset.nav));
window.addEventListener('online', () => { renderBar(); sync(false); });
window.addEventListener('offline', renderBar);
setInterval(() => { if (pendingCount() && navigator.onLine) sync(false); }, 5 * 60 * 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
render();
if (cfg && navigator.onLine) sync(false);

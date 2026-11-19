// Settings (#/settings, #/connections) and Settings, Advanced (#/settings/advanced, CFO only).
// Connections: Zendesk, Outlook, NetSuite (read-only) and the local AI model, each with its status, last sync and what
// it may do in plain words, plus the sync log. The local model settings, the reader check and the mail mode live here.
// Advanced: reset the inbox, import a mailbox export (a tickets file; this is how the Nov 19 file is processed), the
// batch runs, and the results export in score.py's format. Every indicator comes from a real backend answer.
import { h, icon, mount as fill, relTime, fmtMs, fmtInt, humanize, cleanPath, debounce, plural as lplural } from '../lib.js';
import { api } from '../api.js';
import * as inbox from '../api-inbox.js';
import { S, on, emit, refreshModel } from '../state.js';
import {
  button, setBusy, field, setFieldError, badge, dot, table, skeletonText, skeletonRows, empty, notice, tabs, modal, toast, reading,
} from '../components/index.js';
import { pageHead, kv, errText, fmtWhen, ago, liveRegion, say, onAppCalendar } from '../components/leadership/util.js';
import { openFolderPicker } from '../components/leadership/folder-picker.js';
import { subscribe } from '../api-live.js';

const SAMPLE = 'Subject: Payment status for INV-21529\n\nHi, could you tell me when invoice INV-21529 will be paid? You can reach me at zane@dovetaillane.example.\n\nThanks,\nZane';
const MAX_TEXT = 8000;
const CONN_ICON = { zendesk: 'tickets', outlook: 'mail', netsuite: 'database', model: 'cpu' };
const ACTIVE = ['starting', 'running'];

export function mount(root, { route, session }) {
  const isCfo = session?.role === 'cfo';
  const section = route?.section === 'advanced' ? 'advanced' : 'connections';
  let alive = true;
  const cleanups = [];
  const live = liveRegion();

  const body = h('div', { class: 'cx-body' });
  fill(root, h('div', { class: 'page lv-page cx-page' },
    pageHead({ title: 'Settings', lede: 'Where Conductor reads and writes, what each connection may do, and how the local model is set up. Stored on this computer.' }),
    tabs({ label: 'Settings sections', selected: section, items: [
      { id: 'connections', label: 'Connections', href: '#/connections' },
      { id: 'advanced', label: 'Advanced', href: '#/settings/advanced' },
    ] }),
    body, live));

  if (section === 'advanced') {
    if (!isCfo) {
      fill(body, h('div', { class: 'cx-locked' }, icon('lock'), h('p', null, 'Only the CFO can open Advanced.')));
    } else {
      cleanups.push(advanced(body));
    }
  } else {
    cleanups.push(connections(body));
  }

  // ======================================================================================================== connections
  function connections(host) {
    const connSlot = h('div', { class: 'cx-conns' }, skeletonRows({ rows: 2, avatar: false, label: 'Loading connections' }));
    const logSlot = h('div');
    const modelSlot = h('div');
    const trySlot = h('div');
    const mailSlot = h('div');
    fill(host,
      h('section', { class: 'cx-section', 'aria-labelledby': 'cx-conn-h' },
        h('h2', { class: 'lv-section-title', id: 'cx-conn-h' }, 'Connections'), connSlot),
      h('div', { class: 'cx-two' },
        h('div', { class: 'cx-col' }, modelSlot, trySlot),
        h('div', { class: 'cx-col' }, mailSlot, logSlot)));

    let conn = null;
    async function loadConns() {
      try {
        conn = await inbox.connections();
        if (!alive) return;
        renderConns();
      } catch (e) {
        if (alive) fill(connSlot, empty({ icon: 'plug', compact: true, title: 'Connections could not be loaded', text: errText(e), actions: button({ label: 'Try again', icon: 'refresh', onClick: loadConns }) }));
      }
    }
    function renderConns() {
      const tone = (s) => (s === 'connected' ? 'settled' : s === 'syncing' ? 'scheduled' : 'risk');
      const word = (s) => (s === 'connected' ? 'Connected' : s === 'syncing' ? 'Syncing' : 'Not connected');
      fill(connSlot, (conn.connections || []).map((c) => h('article', { class: 'cx-conn', 'aria-labelledby': `cx-c-${c.id}` },
        h('header', { class: 'cx-conn-head' },
          h('span', { class: 'cx-conn-icon', 'aria-hidden': 'true' }, icon(CONN_ICON[c.id] || 'plug')),
          h('h3', { class: 'cx-conn-name', id: `cx-c-${c.id}` }, c.name),
          dot({ tone: tone(c.status), label: word(c.status), live: c.status === 'syncing' })),
        h('p', { class: 'cx-conn-detail' }, c.detail || ''),
        h('ul', { class: 'cx-scopes', 'aria-label': `What ${c.name} may do` }, (c.scopes || []).map((s) => h('li', null, icon(/^no |never/i.test(s) ? 'lock' : 'check', 'icon-sm'), s))),
        h('p', { class: 'cx-conn-sync' }, c.last_sync ? ['Last sync ', h('time', { title: fmtWhen(c.last_sync) }, ago(c.last_sync))] : 'Runs on demand'))));
      fill(logSlot, h('section', { class: 'c-pane cx-log', 'aria-labelledby': 'cx-log-h' },
        h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'cx-log-h' }, 'Sync log'), h('p', { class: 'c-pane-sub' }, 'Newest first.'))),
        h('div', { class: 'c-pane-body is-flush' }, (conn.log || []).length
          ? h('ol', { class: 'cx-logs' }, conn.log.slice(0, 40).map((l) => h('li', null, h('time', { class: 'cx-log-at' }, fmtWhen(l.at)), h('span', null, l.text))))
          : h('p', { class: 'cx-pad lv-muted' }, 'Nothing synced yet.'))));
    }

    // ---- mail
    function renderMail(settings) {
      const m = settings?.mail || {};
      fill(mailSlot, h('section', { class: 'c-pane', 'aria-labelledby': 'cx-mail-h' },
        h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'cx-mail-h' }, 'Email delivery'))),
        h('div', { class: 'c-pane-body' },
          kv([['Mode', m.label || humanize(m.mode || '')], ['From', h('span', { class: 'mono' }, m.from || '')]], 'lv-kv-wide'),
          h('p', { class: 'cx-note' }, 'Set when Conductor starts. It can’t be changed from this page.'))));
    }

    // ---- local model
    let settings = null;
    const statusBox = h('div', { class: 'cx-mstatus', 'aria-live': 'polite' });
    const checkBtn = button({ label: 'Check again', icon: 'refresh', size: 'sm', variant: 'quiet' });
    checkBtn.addEventListener('click', async () => { setBusy(checkBtn, true); try { await refreshModel(true); } finally { if (alive) setBusy(checkBtn, false); } });
    function renderStatus() {
      const m = S.model;
      if (!m) { fill(statusBox, reading({ text: 'Checking the local model…' })); return; }
      const model = m.model || settings?.model?.model || '';
      const map = {
        ready: ['settled', `Connected. ${model} is ready.`],
        unreachable: ['risk', 'Not connected. Start Ollama on this computer, then check again.'],
        model_missing: ['waiting', `Connected, but ${model} is not installed.`],
        no_models: ['waiting', 'Connected, but no models are installed.'],
        not_local: ['risk', 'This address is not on this computer, so it is never contacted.'],
      };
      const [tone, title] = map[m.state] || ['risk', humanize(m.state || 'unknown')];
      const sub = [m.version ? `Ollama ${m.version}` : null, m.host ? `at ${m.host}` : null, m.checked_at ? `checked ${relTime(m.checked_at)}` : null].filter(Boolean).join(' · ');
      fill(statusBox,
        h('div', { class: 'cx-mline' }, dot({ tone, label: title })),
        m.error && m.state !== 'ready' ? h('p', { class: 'cx-note' }, m.error) : null,
        sub ? h('p', { class: 'cx-note' }, sub) : null,
        (m.state === 'model_missing' || m.state === 'no_models') && model ? h('p', { class: 'cx-note' }, 'Install it with ', h('code', { class: 'mono' }, `ollama pull ${model}`), ', or choose an installed model.') : null,
        m.briefs_pending > 0 ? h('p', { class: 'cx-note' }, `Rewriting ${fmtInt(m.briefs_pending)} ${m.briefs_pending === 1 ? 'brief' : 'briefs'} in the background.`) : null);
    }

    const urlF = field({ label: 'Server address', attrs: { class: 'c-input mono', spellcheck: 'false', autocomplete: 'off', inputmode: 'url' }, help: 'Must be on this computer or your local network. Ticket text is never sent anywhere else.' });
    const urlSave = button({ label: 'Save', variant: 'primary', size: 'sm' });
    const urlReset = button({ label: 'Reset to default', variant: 'quiet', size: 'sm' });
    const modelBox = h('div');
    const toF = field({ label: 'Request timeout (seconds)', type: 'number', attrs: { min: '5', max: '600', step: '1', inputmode: 'numeric' }, help: 'How long to wait for the model on one ticket before the regex reader takes over.' });
    const toSave = button({ label: 'Save', variant: 'primary', size: 'sm' });

    async function save(bodyObj, okText, fieldNode, btn) {
      if (fieldNode) setFieldError(fieldNode, null);
      if (btn) setBusy(btn, true);
      try {
        const res = await api.saveModelSettings(bodyObj);
        settings = res.settings; S.settings = res.settings; emit('settings');
        S.model = res.status; emit('model');
        refreshModel(true);
        toast({ message: okText, tone: 'settled' });
        syncForms();
        return true;
      } catch (e) {
        if (fieldNode) setFieldError(fieldNode, errText(e)); else toast({ message: errText(e), tone: 'risk' });
        return false;
      } finally { if (btn && alive) setBusy(btn, false); syncForms(); }
    }
    urlSave.addEventListener('click', () => { const v = urlF.control.value.trim(); if (v) save({ url: v }, 'Server address saved.', urlF, urlSave); });
    urlReset.addEventListener('click', () => save({ url: null }, 'Server address reset to the default.', urlF, urlReset).then(() => { urlF.control.value = settings?.model?.url || ''; }));
    toSave.addEventListener('click', () => {
      const n = Number(toF.control.value);
      if (!Number.isInteger(n) || n < 5 || n > 600) { setFieldError(toF, 'Enter a whole number of seconds from 5 to 600.'); return; }
      save({ timeout_s: n }, `Request timeout set to ${n} seconds.`, toF, toSave);
    });
    urlF.control.addEventListener('input', () => { setFieldError(urlF, null); syncForms(); });
    toF.control.addEventListener('input', () => { setFieldError(toF, null); syncForms(); });
    function syncForms() {
      urlSave.disabled = !urlF.control.value.trim() || urlF.control.value.trim() === (settings?.model?.url ?? '');
      urlReset.hidden = settings?.model?.source?.url !== 'saved';
      toSave.disabled = toF.control.value === '' || String(toF.control.value) === String(settings?.model?.timeout_s ?? '');
    }

    let modelSig = '';
    function renderModels(force) {
      const list = S.model?.models || [];
      const selected = settings?.model?.model || S.model?.model || '';
      const sig = JSON.stringify([list.map((x) => x.name), selected]);
      if (!force && sig === modelSig) return;
      modelSig = sig;
      if (!isCfo) { fill(modelBox, kv([['Model', h('span', { class: 'mono' }, selected)]], 'lv-kv-wide')); return; }
      if (!list.length) {
        const nameF = field({ label: 'Model name', value: selected, attrs: { class: 'c-input mono', spellcheck: 'false' }, help: 'The list of installed models appears once the server is connected.' });
        const b = button({ label: 'Save', variant: 'primary', size: 'sm' });
        b.addEventListener('click', () => { const v = nameF.control.value.trim(); if (v && v !== selected) save({ model: v }, `Model set to ${v}.`, nameF, b); });
        fill(modelBox, h('div', { class: 'cx-inline' }, nameF, b));
        return;
      }
      const size = (bytes) => (bytes ? (bytes / 1e9 >= 1 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`) : '');
      const rows = [];
      if (selected && !list.some((x) => x.name === selected)) rows.push({ name: selected, missing: true });
      rows.push(...list);
      const group = h('fieldset', { class: 'cx-models' }, h('legend', { class: 'c-field-label' }, 'Model'),
        rows.map((r) => {
          const id = `cx-m-${r.name.replace(/[^a-z0-9]/gi, '-')}`;
          const input = h('input', { type: 'radio', name: 'cx-model', id, value: r.name, checked: r.name === selected ? true : null });
          input.addEventListener('change', async () => {
            group.disabled = true;
            const ok = await save({ model: r.name }, `Model set to ${r.name}. New briefs and imports use it.`);
            if (alive) { group.disabled = false; if (!ok) renderModels(true); }
          });
          return h('label', { class: `cx-model${r.name === selected ? ' is-on' : ''}`, for: id }, input,
            h('span', { class: 'cx-model-name mono' }, r.name),
            r.missing ? badge({ label: 'Not installed', tone: 'waiting', icon: 'alert' })
              : h('span', { class: 'cx-model-meta' }, [r.parameter_size, r.quantization, size(r.size_bytes)].filter(Boolean).join(' · ')));
        }));
      fill(modelBox, group);
    }

    function renderModelPane() {
      fill(modelSlot, h('section', { class: 'c-pane cx-model-pane', 'aria-labelledby': 'cx-model-h' },
        h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'cx-model-h' }, 'Local AI model'),
          h('p', { class: 'c-pane-sub' }, 'Reads unclear tickets and rewords briefs. It never changes a decision or writes a payment date.')), checkBtn),
        h('div', { class: 'c-pane-body cx-stack' },
          statusBox,
          isCfo ? h('div', { class: 'cx-inline' }, urlF, h('div', { class: 'cx-btns' }, urlSave, urlReset))
            : kv([['Server address', h('span', { class: 'mono' }, settings?.model?.url || '')], ['Request timeout', `${settings?.model?.timeout_s ?? ''} seconds`]], 'lv-kv-wide'),
          modelBox,
          isCfo ? h('details', { class: 'cx-adv' }, h('summary', null, 'Request timeout', icon('chev-down', 'icon-sm')), h('div', { class: 'cx-inline' }, toF, h('div', { class: 'cx-btns' }, toSave))) : null,
          isCfo ? null : h('p', { class: 'cx-note' }, icon('lock', 'icon-sm'), ' Only the CFO can change model settings.'))));
    }

    // ---- try the reader (streams the model's answer to a sample ticket)
    function renderTry() {
      const ta = field({ label: 'Sample ticket text', type: 'textarea', rows: 6, value: SAMPLE, attrs: { spellcheck: 'false' } });
      const sel = h('select', { class: 'c-input c-select', id: 'cx-try-model' });
      const run = button({ label: 'Read it', variant: 'primary', icon: 'play' });
      const stop = button({ label: 'Stop', icon: 'stop' });
      stop.hidden = true;
      const status = h('span', { class: 'cx-note', role: 'status' });
      const out = h('div', { class: 'cx-out mono', tabindex: '0', role: 'region', 'aria-label': 'Model output' });
      const outWrap = h('div', { class: 'cx-outwrap', hidden: true }, h('p', { class: 'c-field-label' }, 'Model output'), out);
      const result = h('div');
      let ctl = null;
      let seq = 0;
      const names = (S.model?.models || []).map((x) => x.name);
      const selected = settings?.model?.model || S.model?.model || '';
      fill(sel, h('option', { value: '' }, `Selected model (${selected})`), names.filter((n) => n !== selected).map((n) => h('option', { value: n }, n)));
      const sync = () => {
        const t = ta.control.value;
        run.disabled = !t.trim() || t.length > MAX_TEXT || S.model?.state === 'not_local';
        setFieldError(ta, t.length > MAX_TEXT ? `Shorten the text to ${fmtInt(MAX_TEXT)} characters or fewer.` : null);
      };
      ta.control.addEventListener('input', sync);
      ta.control.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !run.disabled) { e.preventDefault(); go(); } });
      async function go() {
        const my = ++seq;
        ctl?.abort();
        ctl = new AbortController();
        out.textContent = ''; fill(result); outWrap.hidden = false;
        run.hidden = true; stop.hidden = false; status.textContent = 'Reading…';
        const bodyObj = { text: ta.control.value };
        if (sel.value) bodyObj.model = sel.value;
        let ended = false;
        try {
          await api.modelTest(bodyObj, { signal: ctl.signal, onEvent: (type, d) => {
            if (my !== seq || ended) return;
            if (type === 'token') { out.append(document.createTextNode(d.text || '')); out.scrollTop = out.scrollHeight; }
            else if (type === 'done') { ended = true; showResult(d); status.textContent = d.reading ? 'Finished' : 'Finished, but the answer could not be read'; }
            else if (type === 'error') { ended = true; fill(result, notice({ tone: 'risk', title: d.message || 'The model could not answer.' })); status.textContent = 'Failed'; }
          } });
          if (my === seq && !ended) { fill(result, notice({ tone: 'risk', title: 'The connection ended before the model finished.' })); status.textContent = 'Failed'; }
        } catch (e) {
          if (my !== seq || e?.name === 'AbortError') return;
          fill(result, notice({ tone: 'risk', title: errText(e, 'The model could not answer.') }));
          status.textContent = 'Failed';
        } finally {
          if (my === seq && alive) { run.hidden = false; stop.hidden = true; }
        }
      }
      function showResult(d) {
        const r = d.reading;
        const list = (a) => (a && a.length ? a.join(', ') : 'None');
        const meta = [fmtMs(d.ms), d.tokens != null ? `${fmtInt(d.tokens)} tokens` : null].filter(Boolean).join(' · ');
        fill(result, r ? h('div', { class: 'cx-result' },
          kv([['Intent', humanize(r.intent)], ['Invoice numbers', h('span', { class: 'mono' }, list(r.invoice_refs))], ['Vendor names', list(r.vendor_names)],
            ['Risk cues', list(r.risk_cues)], ['Safety', `${humanize(r.safety)}${r.safety_reason ? ` · ${r.safety_reason}` : ''}`]], 'lv-kv-wide'),
          d.problem ? notice({ tone: 'waiting', title: 'The model answered, but not in the form the reader needs', text: d.problem }) : null,
          meta ? h('p', { class: 'cx-note' }, meta) : null)
          : notice({ tone: 'waiting', title: 'The model answered, but not in the form the reader needs', text: d.problem || '' }));
      }
      run.addEventListener('click', go);
      stop.addEventListener('click', () => { seq++; ctl?.abort(); run.hidden = false; stop.hidden = true; status.textContent = 'Stopped'; });
      cleanups.push(() => { seq++; ctl?.abort(); });
      sync();
      fill(trySlot, h('section', { class: 'c-pane', 'aria-labelledby': 'cx-try-h' },
        h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'cx-try-h' }, 'Try the reader'),
          h('p', { class: 'c-pane-sub' }, 'See how the local model reads one email. The answer streams as it is written. Nothing is saved.'))),
        h('div', { class: 'c-pane-body cx-stack' }, ta,
          h('div', { class: 'c-field' }, h('label', { class: 'c-field-label', for: 'cx-try-model' }, 'Model'), sel),
          h('div', { class: 'cx-runrow' }, run, stop, status), outWrap, result)));
    }

    async function loadSettings() {
      fill(modelSlot, h('div', { class: 'c-pane cx-pad' }, skeletonText({ lines: 4, label: 'Loading model settings' })));
      try {
        const [s] = await Promise.all([api.settings(), S.model ? null : refreshModel()]);
        if (!alive) return;
        settings = s; S.settings = s;
        urlF.control.value = s.model.url; toF.control.value = s.model.timeout_s;
        renderModelPane(); renderStatus(); renderModels(true); syncForms(); renderMail(s); renderTry();
      } catch (e) {
        if (alive) fill(modelSlot, empty({ icon: 'circle-alert', compact: true, title: 'Model settings could not be loaded', text: errText(e), actions: button({ label: 'Try again', icon: 'refresh', onClick: loadSettings }) }));
      }
    }

    loadConns();
    loadSettings();
    const offModel = on((kind) => { if (kind === 'model' && settings) { renderStatus(); renderModels(false); } });
    const offLive = subscribe((ev) => { if (ev.type === 'sync.status' || ev.type === 'ticket.arrived' || ev.type === 'ticket.sent') loadConns(); });
    const onVis = () => { if (!document.hidden && settings) refreshModel(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { offModel(); offLive?.(); document.removeEventListener('visibilitychange', onVis); };
  }

  // ======================================================================================================== advanced
  function advanced(host) {
    let runs = null;
    let runsError = null;
    let inboxRun = null;
    let poll = 0;
    const runsSlot = h('div');
    const importSlot = h('div');
    const resetSlot = h('div');
    fill(host,
      notice({ tone: 'info', title: 'CFO only', text: 'These change what everyone sees. Each one asks before it acts.' }),
      h('div', { class: 'cx-two' }, h('div', { class: 'cx-col' }, importSlot), h('div', { class: 'cx-col' }, resetSlot)),
      runsSlot);

    // ---- reset
    const resetBtn = button({ label: 'Reset the inbox', variant: 'danger', icon: 'rotate' });
    resetBtn.addEventListener('click', () => {
      modal({
        title: 'Reset the inbox?', size: 'sm',
        description: 'Conductor reads every email again from Zendesk and Outlook and starts the inbox over.',
        body: h('div', { class: 'cx-stack' },
          h('p', null, 'Drafts, approvals, escalations, sign-offs, schedules and chat on inbox tickets are cleared. Messages already sent stay sent. Batch runs below are not touched.'),
          notice({ tone: 'risk', text: 'This can’t be undone.' })),
        actions: (dlg) => {
          const go = button({ label: 'Reset the inbox', variant: 'danger' });
          go.addEventListener('click', async () => {
            setBusy(go, true);
            try {
              const r = await inbox.adminReset();
              dlg.close();
              toast({ message: `Inbox reset. Conductor read ${fmtInt(r.read)} emails; ${fmtInt(r.held_back)} more will arrive.`, tone: 'settled' });
              say(live, 'Inbox reset.');
              loadRuns();
            } catch (e) { setBusy(go, false); toast({ message: errText(e), tone: 'risk' }); }
          });
          return [button({ label: 'Cancel', variant: 'quiet', onClick: () => dlg.close() }), go];
        },
      });
    });
    fill(resetSlot, h('section', { class: 'c-pane', 'aria-labelledby': 'cx-reset-h' },
      h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'cx-reset-h' }, 'Reset the inbox'),
        h('p', { class: 'c-pane-sub' }, 'Start the shared inbox over from the connected mailbox.'))),
      h('div', { class: 'c-pane-body cx-stack' },
        h('p', { class: 'cx-note' }, 'Use it to start a fresh walkthrough. Everyone signed in sees the new inbox straight away.'),
        h('div', null, resetBtn))));

    // ---- import a mailbox export (tickets file)
    const pathF = field({ label: 'Tickets file or folder', attrs: { class: 'c-input mono', spellcheck: 'false', autocomplete: 'off', placeholder: 'C:\\exports\\tickets_nov19.json' },
      help: 'A tickets.json exported from the mailbox, or a folder that holds one. Vendor and bill records come from the folder when it has them, otherwise from the standard records.' });
    const browseBtn = button({ label: 'Browse…', icon: 'folder' });
    const checkBox = h('div', { class: 'cx-check', 'aria-live': 'polite' });
    const importBtn = button({ label: 'Import and process', variant: 'primary', icon: 'download', disabled: true });
    let check = null; // { ok, text, detail }
    let vseq = 0;
    let picking = 0;
    async function validate() {
      const my = ++vseq;
      const p = cleanPath(pathF.control.value);
      check = null;
      importBtn.disabled = true;
      setFieldError(pathF, null);
      if (!p) { fill(checkBox); return; }
      if (/\.json$/i.test(p)) {
        check = { ok: true, text: 'A tickets file. Each ticket runs through the same pipeline as the inbox; nothing is sent.' };
        renderCheck(); return;
      }
      fill(checkBox, reading({ text: 'Checking the folder…' }));
      try {
        const v = await api.validate(p);
        if (my !== vseq) return;
        const ticketsFile = (v.files || []).find((f) => f.name === 'tickets.json');
        if (v.ok) check = { ok: true, text: `A full dataset folder: ${lplural(v.tickets, 'ticket')}${v.has_answer_key ? ', with an answer key' : ''}.` };
        else if (ticketsFile && ticketsFile.status === 'ok') check = { ok: true, text: `A folder with a tickets file${ticketsFile.detail ? ` (${ticketsFile.detail})` : ''}. Records come from the standard data.` };
        else check = { ok: false, text: v.error || 'That folder has no tickets file.' };
      } catch (e) { if (my === vseq) check = { ok: false, text: errText(e) }; }
      renderCheck();
    }
    function renderCheck() {
      importBtn.disabled = !check?.ok;
      if (!check) { fill(checkBox); return; }
      if (!check.ok) setFieldError(pathF, check.text);
      fill(checkBox, check.ok ? badge({ label: 'Ready to import', tone: 'settled', icon: 'check' }) : null, check.ok ? h('span', { class: 'cx-note' }, check.text) : null);
    }
    const validateSoon = debounce(validate, 400);
    pathF.control.addEventListener('input', () => { check = null; importBtn.disabled = true; validateSoon(); });
    const setPath = (p) => { pathF.control.value = p; validate(); };
    browseBtn.addEventListener('click', async () => {
      if (picking) return;
      const mine = ++picking;
      setBusy(browseBtn, true);
      try {
        const r = await api.fsPick(cleanPath(pathF.control.value));
        if (picking === mine && r.path) setPath(r.path);
      } catch (e) {
        if ([404, 405, 501].includes(e.status)) openFolderPicker(cleanPath(pathF.control.value), setPath, { title: 'Choose the folder with the tickets file' });
        else toast({ message: errText(e, 'The folder window could not open.'), tone: 'risk' });
      } finally { if (picking === mine) { picking = 0; setBusy(browseBtn, false); } }
    });
    importBtn.addEventListener('click', async () => {
      const p = cleanPath(pathF.control.value);
      setBusy(importBtn, true);
      try {
        const r = await inbox.adminImport(p);
        toast({ message: 'Imported. Conductor is processing it now; follow it under Batch runs.', tone: 'settled' });
        say(live, 'Import started.');
        await loadRuns(r.run_id);
      } catch (e) { setFieldError(pathF, errText(e)); }
      finally { if (alive) setBusy(importBtn, false); renderCheck(); }
    });
    const importables = h('div');
    fill(importSlot, h('section', { class: 'c-pane', 'aria-labelledby': 'cx-import-h' },
      h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'cx-import-h' }, 'Import a mailbox export'),
        h('p', { class: 'c-pane-sub' }, 'Process a tickets file as a batch, for example the Nov 19 stretch file. It never touches the live inbox.'))),
      h('div', { class: 'c-pane-body cx-stack' },
        h('div', { class: 'cx-inline' }, pathF, h('div', { class: 'cx-btns' }, browseBtn)),
        h('p', { class: 'cx-note' }, 'Or ', h('button', { class: 'lv-linkbtn', type: 'button', onclick: () => openFolderPicker(cleanPath(pathF.control.value), setPath, { title: 'Choose the folder with the tickets file' }) }, 'use the built-in folder list'), '.'),
        checkBox, importables),
      h('footer', { class: 'c-pane-foot' }, h('span', { class: 'lv-spacer' }), importBtn)));

    // ---- runs + export
    async function loadRuns(highlight) {
      try {
        const [d, s] = await Promise.all([api.runs(), inboxRun ? null : inbox.summary().catch(() => null)]);
        if (!alive) return;
        runs = d.runs || [];
        if (s) inboxRun = s.run_id;
        runsError = null;
        fill(importables, (d.importable || []).length ? h('details', { class: 'cx-adv' }, h('summary', null, 'Earlier pipeline results on this computer', icon('chev-down', 'icon-sm')),
          h('ul', { class: 'cx-importables' }, d.importable.slice(0, 8).map((x) => h('li', null, h('span', { class: 'mono' }, x.name), h('span', { class: 'cx-note' }, `${x.size_kb} KB`),
            button({ label: 'Add to runs', size: 'sm', variant: 'quiet', onClick: async (e) => { const b = e.currentTarget; setBusy(b, true); try { await api.importRun(x.path); toast({ message: `Added ${x.name} to the runs.`, tone: 'settled' }); loadRuns(); } catch (err) { setBusy(b, false); toast({ message: errText(err), tone: 'risk' }); } } }))))) : null);
      } catch (e) { if (alive) runsError = errText(e); }
      renderRuns(highlight);
      clearTimeout(poll);
      if ((runs || []).some((r) => ACTIVE.includes(r.status)) && alive) poll = setTimeout(() => loadRuns(), 2000);
    }
    async function exportRun(r, scope, btn) {
      setBusy(btn, true);
      try {
        const url = await inbox.adminExportBlobUrl(r.id, scope);
        const a = h('a', { href: url, download: `results-${(r.label || r.id).replace(/\s+/g, '_')}-${scope}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast({ message: 'Results exported in the scoring format.', tone: 'settled' });
      } catch (e) { toast({ message: errText(e), tone: 'risk' }); }
      finally { setBusy(btn, false); }
    }
    function confirmDelete(r) {
      modal({
        title: `Delete ${r.label || r.id}?`, size: 'sm',
        body: h('p', null, 'Its results, reviews and exports are removed from Conductor. Files already exported stay where you saved them. This can’t be undone.'),
        actions: (dlg) => {
          const go = button({ label: 'Delete run', variant: 'danger' });
          go.addEventListener('click', async () => {
            setBusy(go, true);
            try { await api.deleteRun(r.id); dlg.close(); toast({ message: 'Run deleted.', tone: 'settled' }); loadRuns(); } catch (e) { setBusy(go, false); toast({ message: errText(e), tone: 'risk' }); }
          });
          return [button({ label: 'Cancel', variant: 'quiet', onClick: () => dlg.close() }), go];
        },
      });
    }
    function statusCell(r) {
      if (ACTIVE.includes(r.status)) {
        const pct = r.total ? Math.round((100 * (r.done || 0)) / r.total) : 0;
        return h('span', { class: 'cx-progress' }, h('span', { class: 'cx-progress-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `${r.label || r.id} progress` },
          h('span', { style: { width: `${pct}%` } })), `${fmtInt(r.done || 0)} of ${fmtInt(r.total || 0)}`);
      }
      const map = { done: ['settled', 'Done'], failed: ['risk', 'Failed'], cancelled: ['neutral', 'Stopped'] };
      const [tone, label] = map[r.status] || ['neutral', humanize(r.status)];
      return badge({ label, tone, icon: tone === 'settled' ? 'circle-check' : tone === 'risk' ? 'alert' : null });
    }
    function renderRuns(highlight) {
      const head = h('div', { class: 'lv-section-head' },
        h('div', { class: 'lv-section-titles' }, h('h2', { class: 'lv-section-title' }, 'Batch runs and export'),
          h('p', { class: 'lv-section-sub' }, 'Export results in the scoring format (score.py): signed-off tickets only, or every ticket.')));
      if (runsError) { fill(runsSlot, head, empty({ icon: 'circle-alert', compact: true, title: 'Runs could not be loaded', text: runsError, actions: button({ label: 'Try again', icon: 'refresh', onClick: () => loadRuns() }) })); return; }
      if (!runs) { fill(runsSlot, head, skeletonRows({ rows: 3, avatar: false, label: 'Loading runs' })); return; }
      fill(runsSlot, h('section', { class: 'cx-section' }, head, table({
        caption: 'Batch runs', rowKey: (r) => r.id, selectedKey: highlight || null,
        columns: [
          { key: 'label', label: 'Run', render: (r) => h('span', { class: 'cx-run' }, h('strong', null, r.id === inboxRun ? 'Inbox' : (r.label || r.id)),
            h('span', { class: 'cx-note mono' }, r.id), r.id === inboxRun ? badge({ label: 'Live inbox', tone: 'info' }) : null) },
          { key: 'created_at', label: 'Started', render: (r) => (r.created_at ? fmtWhen(onAppCalendar(r.created_at)) : '') },
          { key: 'total', label: 'Tickets', kind: 'num', render: (r) => fmtInt(r.counts?.total ?? r.total ?? 0) },
          { key: 'drafts', label: 'Drafts', kind: 'num', render: (r) => fmtInt(r.counts?.draft_reply ?? 0) },
          { key: 'status', label: 'Status', render: statusCell },
          { key: 'actions', label: 'Export', render: (r) => h('span', { class: 'cx-rowacts' },
            button({ label: 'Signed off', size: 'sm', icon: 'download', disabled: r.status !== 'done', attrs: { 'aria-label': `Export signed-off results of ${r.label || r.id}` }, onClick: (e) => exportRun(r, 'signed_off', e.currentTarget) }),
            button({ label: 'All', size: 'sm', variant: 'quiet', disabled: r.status !== 'done', attrs: { 'aria-label': `Export every result of ${r.label || r.id}` }, onClick: (e) => exportRun(r, 'all', e.currentTarget) }),
            r.id === inboxRun ? null : h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': `Delete ${r.label || r.id}`, title: 'Delete run', disabled: ACTIVE.includes(r.status) || null, onclick: () => confirmDelete(r) }, icon('trash'))) },
        ],
        rows: runs,
        empty: empty({ icon: 'list', compact: true, title: 'No batch runs yet', text: 'Import a tickets file to start one.' }),
      })));
    }

    renderRuns();
    loadRuns();
    return () => { clearTimeout(poll); validateSoon.cancel(); vseq++; };
  }

  return {
    destroy() { alive = false; cleanups.forEach((f) => { try { f?.(); } catch { /* already gone */ } }); },
  };
}

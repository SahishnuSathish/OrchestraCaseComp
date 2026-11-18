// Settings: local model connection, model choice, streaming test console, mail delivery status.
// Every indicator shown here comes from a real answer of the backend (status.checked_at is always shown).
import { h, icon, mount as fill, fmtMs, relTime, humanize, fmtInt } from '../lib.js';
import { api } from '../api.js';
import { S, on, emit, refreshModel } from '../state.js';
import { pageHeader, panel, banner, copyButton, toast } from '../ui.js';

const SAMPLE = 'Subject: Payment status for INV-21529\n\nHi, could you tell me when invoice INV-21529 will be paid? You can reach me at zane@dovetaillane.example.\n\nThanks,\nZane';
const MAX_TEXT = 8000;
const PRIVACY = 'Must be on this computer or your local network. Ticket text is never sent anywhere else.';

const fmtSize = (b) => {
  if (!b) return '';
  const gb = b / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
};
const modelDetails = (m) => [m.parameter_size, m.quantization, fmtSize(m.size_bytes)].filter(Boolean).join(' · ');

let uid = 0;
const nid = (p) => `st-${p}-${++uid}`;

// ---- hints shared by the status block and the test console -------------------------------------------------------
function pullHint(model, lead) {
  return h('div', { class: 'st-hint' },
    lead ? h('p', { class: 'muted' }, lead) : null,
    model ? h('div', { class: 'st-cmd' }, h('code', { class: 'mono' }, `ollama pull ${model}`), copyButton(`ollama pull ${model}`, 'Copy')) : null);
}
function hintFor(kind, model) {
  if (kind === 'unreachable') return h('p', { class: 'muted' }, 'Start Ollama on this computer, then check again.');
  if (kind === 'model_missing') return pullHint(model, null);
  if (kind === 'no_models') return pullHint(model, null);
  return null;
}

export function mount(root) {
  let alive = true;
  let settings = null;
  const offs = [];

  // =========================================================================================================== model panel
  const statusBox = h('div', { class: 'st-status', 'aria-live': 'polite' });
  const checkBtn = h('button', { class: 'btn btn-sm', type: 'button' }, icon('refresh'), h('span', null, 'Check again'));
  let checking = false;
  checkBtn.addEventListener('click', async () => {
    if (checking) return;
    checking = true; checkBtn.disabled = true;
    checkBtn.replaceChildren(h('span', { class: 'spinner spinner-sm' }), h('span', null, 'Checking...'));
    try { await refreshModel(true); } finally {
      checking = false;
      if (alive) { checkBtn.disabled = false; checkBtn.replaceChildren(icon('refresh'), h('span', null, 'Check again')); }
    }
  });

  function renderStatus() {
    const m = S.model;
    if (!m) { fill(statusBox, h('div', { class: 'st-state' }, h('span', { class: 'spinner spinner-sm' }), h('span', { class: 'muted' }, 'Checking the local model...'))); return; }
    const model = m.model || settings?.model?.model || '';
    let tone = 'ok', title, detail = null, hint = null;
    switch (m.state) {
      case 'ready': title = `Connected · ${model} is ready`; break;
      case 'unreachable': tone = 'bad'; title = 'Not connected'; detail = m.error; hint = /start ollama/i.test(m.error || '') ? null : hintFor('unreachable'); break;
      case 'model_missing': tone = 'warn'; title = `Connected, but ${model} is not installed`; hint = h('div', null, pullHint(model), h('p', { class: 'muted' }, 'or choose an installed model below.')); break;
      case 'no_models': tone = 'warn'; title = 'Connected, but no models are installed'; hint = pullHint(model); break;
      case 'not_local': tone = 'bad'; title = 'This address is not on this computer'; detail = m.error; break;
      default: tone = 'bad'; title = humanize(m.state || 'unknown'); detail = m.error;
    }
    const ic = tone === 'ok' ? 'circle-check' : tone === 'warn' ? 'alert' : 'circle-alert';
    const sub = [m.version ? `Ollama ${m.version}` : null, m.host ? `${m.version ? 'at ' : ''}${m.host}` : null].filter(Boolean).join(' ');
    const checked = m.checked_at ? `checked ${relTime(m.checked_at)}` : '';
    fill(statusBox,
      h('div', { class: `st-state st-${tone}` }, icon(ic), h('strong', null, title)),
      detail ? h('p', { class: 'st-detail' }, detail) : null,
      (sub || checked) ? h('p', { class: 'st-sub muted', title: m.checked_at ? new Date(m.checked_at * 1000).toLocaleString() : null }, [sub, checked].filter(Boolean).join(' · ')) : null,
      hint ? h('div', { class: 'st-hintwrap' }, hint) : null,
      m.briefs_pending > 0 ? h('p', { class: 'st-info' }, icon('info'), `Rewriting ${fmtInt(m.briefs_pending)} ${m.briefs_pending === 1 ? 'brief' : 'briefs'} in the background.`) : null);
  }

  // ---- server address
  const urlInput = h('input', { class: 'input mono', id: nid('url'), type: 'text', autocomplete: 'off', spellcheck: 'false', inputmode: 'url', 'aria-describedby': '' });
  const urlErr = h('p', { class: 'st-err', role: 'alert', hidden: true });
  const urlSave = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
  const urlReset = h('button', { class: 'btn', type: 'button' }, 'Reset to default');
  const urlHelpId = nid('urlhelp');
  urlInput.setAttribute('aria-describedby', urlHelpId);
  let urlBusy = false;
  const setErr = (input, box, msg, helpId) => {
    box.hidden = !msg; box.textContent = msg || '';
    if (msg) { input.setAttribute('aria-invalid', 'true'); box.id = box.id || nid('err'); input.setAttribute('aria-describedby', `${box.id} ${helpId}`); }
    else { input.removeAttribute('aria-invalid'); input.setAttribute('aria-describedby', helpId); }
  };
  function syncUrl() {
    const cur = settings?.model?.url ?? '';
    urlSave.disabled = urlBusy || !urlInput.value.trim() || urlInput.value.trim() === cur;
    urlInput.disabled = urlBusy;
    urlReset.hidden = settings?.model?.source?.url !== 'saved';
    urlReset.disabled = urlBusy;
  }
  urlInput.addEventListener('input', () => { setErr(urlInput, urlErr, '', urlHelpId); syncUrl(); });

  async function saveModelCfg(body) {
    const res = await api.saveModelSettings(body);
    settings = res.settings; S.settings = res.settings; emit('settings');
    S.model = res.status; emit('model');
    refreshModel(true);
    return res;
  }
  async function submitUrl(value) {
    if (urlBusy) return;
    urlBusy = true; urlSave.textContent = value === null ? 'Save' : 'Saving...'; syncUrl();
    if (value === null) urlReset.textContent = 'Resetting...';
    setErr(urlInput, urlErr, '', urlHelpId);
    try {
      await saveModelCfg({ url: value });
      urlInput.value = settings.model.url;
      toast({ message: value === null ? 'Server address reset to the default.' : 'Server address saved.' });
    } catch (e) {
      setErr(urlInput, urlErr, e.message, urlHelpId);
    } finally {
      urlBusy = false; urlSave.textContent = 'Save'; urlReset.textContent = 'Reset to default';
      if (alive) syncUrl();
    }
  }
  urlReset.addEventListener('click', () => submitUrl(null));
  const urlForm = h('form', { class: 'field st-field', novalidate: true, onsubmit: (e) => { e.preventDefault(); if (!urlSave.disabled) submitUrl(urlInput.value.trim()); } },
    h('label', { class: 'label', for: urlInput.id }, 'Server address'),
    h('div', { class: 'st-inline' }, urlInput, h('div', { class: 'st-btns' }, urlSave, urlReset)),
    urlErr,
    h('p', { class: 'help', id: urlHelpId }, PRIVACY));

  // ---- model choice
  const modelBox = h('div', { class: 'st-modelbox' });
  let modelSaving = false;
  let modelSig = '';
  const modelErr = h('p', { class: 'st-err', role: 'alert', hidden: true });
  const nameInput = h('input', { class: 'input mono', id: nid('mname'), type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': '' });
  const nameHelpId = nid('mhelp');
  nameInput.setAttribute('aria-describedby', nameHelpId);
  const nameSave = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
  const nameErr = h('p', { class: 'st-err', role: 'alert', hidden: true });
  let nameBusy = false;
  function syncName() {
    nameSave.disabled = nameBusy || !nameInput.value.trim() || nameInput.value.trim() === (settings?.model?.model ?? '');
    nameInput.disabled = nameBusy;
  }
  nameInput.addEventListener('input', () => { setErr(nameInput, nameErr, '', nameHelpId); syncName(); });
  const nameForm = h('form', { class: 'field st-field', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (nameBusy || nameSave.disabled) return;
    nameBusy = true; nameSave.textContent = 'Saving...'; syncName(); setErr(nameInput, nameErr, '', nameHelpId);
    try {
      await saveModelCfg({ model: nameInput.value.trim() });
      toast({ message: `Model set to ${settings.model.model}. New runs and brief rewrites will use it.` });
    } catch (err) { setErr(nameInput, nameErr, err.message, nameHelpId); }
    finally { nameBusy = false; nameSave.textContent = 'Save'; if (alive) syncName(); }
  } },
    h('label', { class: 'label', for: nameInput.id }, 'Model name'),
    h('div', { class: 'st-inline' }, nameInput, h('div', { class: 'st-btns' }, nameSave)),
    nameErr,
    h('p', { class: 'help', id: nameHelpId }, 'The list of installed models appears once the server is connected.'));

  function renderModels(force) {
    const m = S.model;
    const list = m?.models || [];
    const selected = (settings?.model?.model) || m?.model || '';
    const sig = JSON.stringify([list.map((x) => x.name), selected, list.length > 0]);
    if (!force && sig === modelSig) return;
    if (modelSaving) return;
    modelSig = sig;
    const hadFocus = modelBox.contains(document.activeElement);
    if (!list.length) {
      if (!nameInput.matches(':focus') && document.activeElement !== nameInput) nameInput.value = nameInput.value || selected;
      fill(modelBox, nameForm);
      syncName();
      return;
    }
    const rows = [];
    const installed = list.some((x) => x.name === selected);
    if (selected && !installed) rows.push({ name: selected, missing: true });
    rows.push(...list);
    const group = h('fieldset', { class: 'st-models' }, h('legend', { class: 'label' }, 'Model'));
    rows.forEach((r, i) => {
      const id = nid('m');
      const input = h('input', { type: 'radio', name: 'st-model', id, value: r.name, checked: r.name === selected ? true : null });
      input.addEventListener('change', () => chooseModel(r.name, group, selected));
      group.append(h('label', { class: `st-model${r.name === selected ? ' on' : ''}`, for: id },
        input,
        h('span', { class: 'st-model-main' },
          h('span', { class: 'st-model-name mono' }, r.name),
          r.missing ? h('span', { class: 'badge badge-warning' }, icon('alert'), 'Not installed') : null),
        r.missing ? null : h('span', { class: 'st-model-meta muted' }, modelDetails(r))));
    });
    fill(modelBox, group, modelErr);
    if (hadFocus) (group.querySelector('input:checked') || group.querySelector('input'))?.focus();
  }
  async function chooseModel(name, group, previous) {
    if (modelSaving) return;
    modelSaving = true;
    const had = group.contains(document.activeElement);
    setErr({ setAttribute() {}, removeAttribute() {} }, modelErr, '', '');
    group.disabled = true; group.setAttribute('aria-busy', 'true');
    try {
      await saveModelCfg({ model: name });
      toast({ message: `Model set to ${name}. New runs and brief rewrites will use it.` });
    } catch (e) {
      setErr({ setAttribute() {}, removeAttribute() {} }, modelErr, e.message, '');
      group.querySelectorAll('input').forEach((i) => { i.checked = i.value === previous; });
    } finally {
      modelSaving = false;
      if (alive) {
        group.disabled = false; group.removeAttribute('aria-busy');
        renderModels(true);
        if (modelErr.textContent) modelErr.hidden = false;
        if (had) modelBox.querySelector('input:checked')?.focus();
      }
    }
  }

  // ---- advanced: timeout
  const toInput = h('input', { class: 'input', id: nid('to'), type: 'number', inputmode: 'numeric', min: '5', max: '600', step: '1' });
  const toHelpId = nid('tohelp');
  toInput.setAttribute('aria-describedby', toHelpId);
  const toSave = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
  const toErr = h('p', { class: 'st-err', role: 'alert', hidden: true });
  let toBusy = false;
  function syncTo() {
    toSave.disabled = toBusy || toInput.value === '' || String(toInput.value) === String(settings?.model?.timeout_s ?? '');
    toInput.disabled = toBusy;
  }
  toInput.addEventListener('input', () => { setErr(toInput, toErr, '', toHelpId); syncTo(); });
  const toForm = h('form', { class: 'field st-field', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (toBusy || toSave.disabled) return;
    const n = Number(toInput.value);
    if (!Number.isInteger(n)) { setErr(toInput, toErr, 'Enter a whole number of seconds between 5 and 600.', toHelpId); return; }
    toBusy = true; toSave.textContent = 'Saving...'; syncTo(); setErr(toInput, toErr, '', toHelpId);
    try {
      await saveModelCfg({ timeout_s: n });
      toInput.value = settings.model.timeout_s;
      toast({ message: `Request timeout set to ${settings.model.timeout_s} seconds.` });
    } catch (err) { setErr(toInput, toErr, err.message, toHelpId); }
    finally { toBusy = false; toSave.textContent = 'Save'; if (alive) syncTo(); }
  } },
    h('label', { class: 'label', for: toInput.id }, 'Request timeout (seconds)'),
    h('div', { class: 'st-inline' }, toInput, h('div', { class: 'st-btns' }, toSave)),
    toErr,
    h('p', { class: 'help', id: toHelpId }, 'How long to wait for the model on one ticket before falling back to the regex reader.'));
  const advanced = h('details', { class: 'section st-adv' }, h('summary', null, 'Advanced: request timeout', icon('chev-down', 'chev')), h('div', { class: 'section-body' }, toForm));

  const modelPanel = panel({
    title: 'Local model', icon: 'cpu', actions: checkBtn,
    body: h('div', { class: 'st-col' }, statusBox, urlForm, modelBox, advanced),
    foot: h('p', { class: 'st-foot' }, 'Used as the second reader in runs and to rewrite briefs. A run that is already in progress keeps the model it started with.'),
  });

  // =========================================================================================================== test panel
  const ta = h('textarea', { class: 'textarea', id: nid('ta'), rows: '7', spellcheck: 'false', 'aria-describedby': '' });
  ta.value = SAMPLE;
  const counter = h('p', { class: 'st-count', id: nid('count'), hidden: true });
  ta.setAttribute('aria-describedby', counter.id);
  const testSel = h('select', { class: 'select', id: nid('tsel') });
  let testModel = '';
  let selSig = '';
  const runBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('play'), h('span', null, 'Run test'), h('span', { class: 'kbd st-kbd', 'aria-hidden': 'true' }, 'Ctrl+Enter'));
  const stopBtn = h('button', { class: 'btn', type: 'button', hidden: true }, icon('stop'), h('span', null, 'Stop'));
  const runStatus = h('p', { class: 'st-runstatus muted', role: 'status' });
  const sentPre = h('pre', { class: 'st-pre mono' });
  const sentDet = h('details', { class: 'st-sent', hidden: true }, h('summary', null, 'What was sent to the model (after redaction)'), sentPre);
  const outLabel = h('div', { class: 'label' }, 'Model output');
  const out = h('div', { class: 'st-out mono', tabindex: '0', role: 'region', 'aria-label': 'Model output', 'aria-live': 'off' });
  const outWrap = h('div', { class: 'st-outwrap', hidden: true }, outLabel, out);
  const resultBox = h('div', { class: 'st-result' });
  const errBox = h('div', { class: 'st-errbox' });

  let phase = 'idle'; // idle | running | done | stopped | failed
  let ctl = null;
  let runSeq = 0;
  let pinned = true;
  let pending = '';
  let raf = 0;

  out.addEventListener('scroll', () => { pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 24; });
  function flushTokens() {
    raf = 0;
    if (!pending) return;
    out.append(document.createTextNode(pending));
    pending = '';
    if (pinned) out.scrollTop = out.scrollHeight;
  }
  function pushToken(t) { pending += t; if (!raf) raf = requestAnimationFrame(flushTokens); }
  function drainTokens() { if (raf) { cancelAnimationFrame(raf); raf = 0; } flushTokens(); }

  function canRun() {
    const t = ta.value;
    return t.trim().length > 0 && t.length <= MAX_TEXT && S.model?.state !== 'not_local';
  }
  function syncRun() {
    const running = phase === 'running';
    runBtn.disabled = running || !canRun();
    const len = ta.value.length;
    const over = len > MAX_TEXT;
    counter.hidden = !(len >= 7000);
    counter.textContent = over ? `${fmtInt(len)} / ${fmtInt(MAX_TEXT)} characters. Shorten the text by ${fmtInt(len - MAX_TEXT)} to run the test.` : `${fmtInt(len)} / ${fmtInt(MAX_TEXT)} characters`;
    counter.classList.toggle('over', over);
    if (over) ta.setAttribute('aria-invalid', 'true'); else ta.removeAttribute('aria-invalid');
    testSel.disabled = running;
    runBtn.title = S.model?.state === 'not_local' ? 'The server address is not on this computer, so nothing can be tested.' : '';
  }
  ta.addEventListener('input', syncRun);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!runBtn.disabled) runTest(); } });
  testSel.addEventListener('change', () => { testModel = testSel.value; });

  function renderTestSelect() {
    const m = S.model;
    const names = (m?.models || []).map((x) => x.name);
    const selected = settings?.model?.model || m?.model || '';
    const sig = JSON.stringify([names, selected]);
    if (sig === selSig) return;
    selSig = sig;
    if (testModel && !names.includes(testModel)) testModel = '';
    testSel.replaceChildren(h('option', { value: '' }, `Selected model (${selected})`),
      ...names.filter((n) => n !== selected).map((n) => h('option', { value: n }, `Try ${n}`)));
    testSel.value = testModel;
  }

  function setPhase(p, text) {
    phase = p;
    runStatus.textContent = text || '';
    const hadStop = document.activeElement === stopBtn;
    const running = p === 'running';
    runBtn.hidden = running; stopBtn.hidden = !running;
    syncRun();
    if (running && document.activeElement === document.body) stopBtn.focus();
    if (hadStop && !running) runBtn.focus();
  }

  function showResult(d, model) {
    const r = d.reading;
    const meta = h('p', { class: 'st-meta muted' }, [fmtMs(d.ms), d.tokens != null ? `${fmtInt(d.tokens)} tokens` : null, model].filter(Boolean).join(' · '));
    const list = (a) => (a && a.length ? a.join(', ') : 'None');
    if (!r) {
      fill(resultBox, banner({ tone: 'warning', title: 'The model answered, but not in the form the reader needs', text: d.problem || '', role: null }), meta);
      return;
    }
    fill(resultBox,
      h('h3', { class: 'st-h3' }, 'Result'),
      h('dl', { class: 'kv st-kv' },
        h('dt', null, 'Intent'), h('dd', null, humanize(r.intent)),
        h('dt', null, 'Invoice numbers'), h('dd', { class: 'mono' }, list(r.invoice_refs)),
        h('dt', null, 'Vendor names'), h('dd', null, list(r.vendor_names)),
        h('dt', null, 'Risk cues'), h('dd', null, list(r.risk_cues)),
        h('dt', null, 'Safety'), h('dd', null, humanize(r.safety), r.safety_reason ? h('span', { class: 'muted' }, ` · ${r.safety_reason}`) : null)),
      d.problem ? banner({ tone: 'warning', title: 'The model answered, but not in the form the reader needs', text: d.problem }) : null,
      meta);
  }

  function showError(kind, message, model) {
    drainTokens();
    if (!out.textContent) outWrap.hidden = true;
    const hint = kind === 'unreachable' && !/start ollama/i.test(message || '') ? hintFor('unreachable').textContent.replace('check again', 'try again')
      : null;
    const extra = kind === 'model_missing' ? pullHint(model) : null;
    const again = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { if (!runBtn.disabled) runTest(); } }, icon('refresh'), 'Try again');
    fill(errBox, h('div', { class: 'banner banner-danger', role: 'alert' }, icon('circle-alert'),
      h('div', { class: 'banner-body' }, h('strong', null, message), hint ? h('span', null, hint) : null, extra),
      h('div', { class: 'banner-actions' }, again)));
  }

  async function runTest() {
    if (phase === 'running' || !canRun()) return;
    ctl?.abort();
    const my = ++runSeq;
    ctl = new AbortController();
    const myCtl = ctl;
    const body = { text: ta.value };
    if (testModel) body.model = testModel;
    const usedModel = testModel || settings?.model?.model || S.model?.model || '';
    let model = usedModel;
    pending = ''; pinned = true; out.replaceChildren();
    fill(resultBox); fill(errBox); sentDet.hidden = true; sentPre.textContent = '';
    outWrap.hidden = false;
    setPhase('running', 'Running...');
    let ended = false;
    try {
      await api.modelTest(body, { signal: myCtl.signal, onEvent: (type, d) => {
        if (my !== runSeq || ended) return;
        if (type === 'start') {
          model = d.model || model;
          sentPre.textContent = d.sent || ''; sentDet.hidden = false;
        } else if (type === 'token') {
          pushToken(d.text || '');
        } else if (type === 'done') {
          ended = true; drainTokens(); showResult(d, model);
          setPhase('done', d.reading ? 'Finished' : 'Finished, but the answer could not be read');
        } else if (type === 'error') {
          ended = true; showError(d.kind, d.message, model);
          setPhase('failed', 'Failed');
        }
      } });
      if (my === runSeq && !ended) {
        showError('http', 'The connection ended before the test finished.', model);
        setPhase('failed', 'Failed');
      }
    } catch (e) {
      if (my !== runSeq) return;
      if (e?.name === 'AbortError') return; // handled by stop()
      drainTokens();
      showError(e?.kind || 'http', e?.message || 'The test could not be completed.', model);
      setPhase('failed', 'Failed');
    }
  }
  function stop() {
    if (phase !== 'running') return;
    runSeq++; // ignore anything still in flight
    ctl?.abort();
    drainTokens();
    if (!out.textContent) outWrap.hidden = true;
    fill(errBox);
    fill(resultBox, h('p', { class: 'muted st-stopped' }, 'Stopped.'));
    setPhase('stopped', 'Stopped');
  }
  runBtn.addEventListener('click', runTest);
  stopBtn.addEventListener('click', stop);

  const testPanel = panel({
    title: 'Test the reader', icon: 'play',
    body: h('div', { class: 'st-col' },
      h('p', { class: 'muted st-note' }, 'Output streams here as the model writes it. Pipeline runs and brief rewrites wait for the complete answer instead.'),
      h('div', { class: 'field st-field' }, h('label', { class: 'label', for: ta.id }, 'Sample ticket text'), ta, counter),
      h('div', { class: 'field st-field st-selfield' }, h('label', { class: 'label', for: testSel.id }, 'Model'), testSel),
      h('div', { class: 'st-actions' }, runBtn, stopBtn, runStatus),
      errBox, sentDet, outWrap, resultBox),
  });

  // =========================================================================================================== mail panel
  const mailBody = h('div', { class: 'st-col' });
  function renderMail() {
    const mail = settings?.mail;
    fill(mailBody,
      h('dl', { class: 'kv st-kv' },
        h('dt', null, 'Mode'), h('dd', null, mail?.label || mail?.mode || ''),
        h('dt', null, 'From'), h('dd', { class: 'mono' }, mail?.from || '')),
      h('p', { class: 'muted st-note' }, "Set when Conductor starts (environment variables). It can't be changed from this page."));
  }
  const mailPanel = panel({ title: 'Email delivery', icon: 'mail', body: mailBody });

  // =========================================================================================================== page
  const content = h('div', { class: 'page-grid st-grid' }, modelPanel, testPanel, mailPanel);
  const page = h('div', { class: 'page st-page' }, pageHeader({ title: 'Settings', meta: 'Stored on this computer.' }));
  fill(root, page);

  function loading() {
    page.append(h('div', { class: 'page-grid st-grid', 'aria-busy': 'true' },
      ...[0, 1, 2].map(() => h('div', { class: 'panel' }, h('div', { class: 'panel-body st-skel' },
        h('div', { class: 'skeleton', style: { height: '16px', width: '40%' } }), h('div', { class: 'skeleton', style: { height: '36px' } }), h('div', { class: 'skeleton', style: { height: '36px', width: '70%' } }))))));
  }
  async function load() {
    page.querySelector('.st-grid')?.remove();
    page.querySelector('.st-loaderr')?.remove();
    loading();
    try {
      const [s] = await Promise.all([api.settings(), S.model ? null : refreshModel()]);
      if (!alive) return;
      settings = s; S.settings = s;
      page.querySelector('.st-grid')?.remove();
      page.append(content);
      urlInput.value = s.model.url; nameInput.value = s.model.model; toInput.value = s.model.timeout_s;
      syncUrl(); syncName(); syncTo(); renderMail(); renderStatus(); renderModels(true); renderTestSelect(); syncRun();
    } catch (e) {
      if (!alive) return;
      page.querySelector('.st-grid')?.remove();
      page.append(h('div', { class: 'st-loaderr' }, panel({ title: 'Settings', icon: 'alert', body: h('div', { class: 'st-col' },
        h('p', { role: 'alert' }, e.message || 'Settings could not be loaded.'),
        h('div', null, h('button', { class: 'btn btn-primary', type: 'button', onclick: load }, 'Retry'))) })));
    }
  }
  load();

  offs.push(on((kind) => {
    if (!settings) return;
    if (kind === 'model') { renderStatus(); renderModels(false); renderTestSelect(); syncRun(); }
  }));
  const onVis = () => { if (!document.hidden && settings) refreshModel(); };
  document.addEventListener('visibilitychange', onVis);

  return {
    update() {},
    destroy() {
      alive = false;
      runSeq++;
      ctl?.abort();
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      offs.forEach((f) => f());
    },
  };
}

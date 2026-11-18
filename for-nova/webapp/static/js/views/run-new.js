// New run: choose a dataset folder, validate it, pick the reader, start. The run itself is watched on its Overview.
import { h, icon, mount as fill, debounce, ls, fmtDuration, plural } from '../lib.js';
import { api } from '../api.js';
import { S, on, refreshModel } from '../state.js';
import { openDialog, toast, pageHeader, panel, banner } from '../ui.js';
import { href, navigate } from '../router.js';

const ACTIVE = ['starting', 'running'];
const folderName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p || '';

export function mount(root, { route }) {
  const q = route.query || {};
  const stored = ls('ap.reader');
  const ui = {
    path: q.dataset || ls('ap.dataset') || '', validation: null, validating: false, submitting: false, checking: false,
    reader: q.model === '1' ? 'model' : q.model === '0' ? 'regex' : q.model === 'none' ? 'none' : (['model', 'regex', 'none'].includes(stored) ? stored : null),
    limit: /^[1-9]\d*$/.test(q.limit || '') ? q.limit : '',
    activeRun: null, startError: null,
  };
  const off = [];
  let alive = true;

  const bannerSlot = h('div');
  const datasetBody = h('div', { class: 'stack' });
  const readerBody = h('div', { class: 'stack' });
  const summaryBody = h('div');
  const step = (n) => h('span', { class: 'step-num', 'aria-hidden': 'true' }, n);
  const errorSlot = h('div', { 'aria-live': 'polite' });
  const cancelLink = h('a', { class: 'btn btn-lg', href: href('runs') }, 'Cancel');
  const startBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => start() });
  const reasonLine = h('span', { class: 'nr-reason faint' });

  fill(root, h('div', { class: 'page' },
    pageHeader({
      title: 'New run', back: { label: 'Runs', href: href('runs') },
      meta: 'Run every ticket in a dataset folder through the pipeline. Replies are drafted for review; nothing is sent.',
    }),
    bannerSlot,
    h('div', { class: 'page-grid two nr-grid' },
      h('div', { class: 'nr-main' },
        panel({ title: [step(1), 'Dataset folder'], body: datasetBody }),
        panel({ title: [step(2), 'Reader'], body: readerBody })),
      h('div', { class: 'nr-aside' }, panel({ title: 'Summary', icon: 'list', body: summaryBody })),
      h('div', { class: 'nr-actions' }, errorSlot, h('div', { class: 'nr-actions-row' }, reasonLine, cancelLink, startBtn)))));

  // ------------------------------------------------------------------ 1. dataset
  const input = h('input', { class: 'input mono', id: 'dataset-path', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: '/path/to/dataset', 'aria-describedby': 'dataset-status', value: ui.path });
  const validationBox = h('div', { id: 'dataset-status', 'aria-live': 'polite' });
  const browseBtn = h('button', { class: 'btn', type: 'button', onclick: () => openFolderPicker(ui.path, (p) => setPath(p, true)) }, icon('folder'), 'Browse…');
  fill(datasetBody,
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'dataset-path' }, 'Folder'), h('div', { class: 'input-row' }, input, browseBtn),
      h('p', { class: 'help' }, 'The folder that holds tickets.json and the vendor, employee, bill, payment and payment-run CSVs.')),
    validationBox);

  function setPath(p, immediate) {
    ui.path = p; input.value = p; ls('ap.dataset', p); ui.startError = null;
    immediate ? validate() : validateSoon();
  }
  const validateSoon = debounce(() => validate(), 400);
  input.addEventListener('input', () => {
    ui.path = input.value.trim(); ui.startError = null; ui.validation = null; ui.validating = !!ui.path;
    renderValidation(); renderAll(); validateSoon();
  });
  input.addEventListener('change', () => ls('ap.dataset', ui.path));

  let vSeq = 0;
  async function validate() {
    const seq = ++vSeq;
    if (!ui.path) { ui.validation = null; ui.validating = false; renderValidation(); renderAll(); return; }
    ui.validating = true; renderValidation(); renderAll();
    try {
      const v = await api.validate(ui.path);
      if (seq !== vSeq) return;
      ui.validation = v;
    } catch (e) { if (seq !== vSeq) return; ui.validation = { ok: false, error: e.message, files: [] }; }
    ui.validating = false;
    renderValidation(); renderAll();
  }

  function renderValidation() {
    const v = ui.validation;
    input.setAttribute('aria-invalid', v && !v.ok && !ui.validating ? 'true' : 'false');
    if (!ui.path) return fill(validationBox, h('p', { class: 'muted' }, 'Choose a folder to begin.'));
    if (ui.validating) return fill(validationBox, h('div', { class: 'row muted', role: 'status' }, h('span', { class: 'spinner' }), 'Checking folder…'));
    if (!v) return fill(validationBox);
    const items = (v.files || []).map((f) => {
      const cls = f.status === 'ok' ? 'ok' : f.status === 'absent' ? 'absent' : f.required ? 'bad' : 'warn';
      const ic = f.status === 'ok' ? 'circle-check' : f.status === 'absent' ? 'circle-dash' : f.required ? 'circle-x' : 'circle-alert';
      return h('li', { class: `check ${cls}` }, icon(ic), h('span', { class: 'name truncate', title: f.name }, f.name), h('span', { class: 'detail' }, f.detail));
    });
    fill(validationBox,
      h('div', { class: 'stack-sm' },
        v.ok
          ? h('div', { class: 'row nr-ready' }, h('span', { class: 'badge badge-success' }, icon('check'), 'Ready'), h('span', null, `${plural(v.tickets, 'ticket')} found`, v.has_answer_key ? ' · answer key present, so results can be scored' : ''))
          : banner({ tone: 'danger', role: 'alert', title: v.error || 'This folder cannot be used', text: v.exists ? 'Fix the missing items below, or pick another folder.' : null }),
        items.length ? h('ul', { class: 'checklist' }, items) : null));
  }

  // ------------------------------------------------------------------ 2. reader
  const mkRadio = (value) => {
    const r = h('input', { type: 'radio', name: 'reader', id: `reader-${value}`, value });
    r.addEventListener('change', () => { if (r.checked) { ui.reader = value; ls('ap.reader', value); renderAll(); } });
    return r;
  };
  const rRegex = mkRadio('regex');
  const rModel = mkRadio('model');
  const rNone = mkRadio('none');
  const modelName = h('span', { class: 'mono choice-tag' });
  const modelExtra = h('div', { class: 'choice-extra' });
  const limitInput = h('input', { class: 'input', id: 'limit', type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: 'All', 'aria-describedby': 'limit-help', value: ui.limit });
  const limitHelp = h('p', { class: 'help', id: 'limit-help' }, 'Process only the first N tickets, for a quick trial. Leave empty for all.');
  limitInput.addEventListener('input', () => { ui.limit = limitInput.value.trim(); ui.startError = null; renderAll(); });

  fill(readerBody,
    h('fieldset', { class: 'choices' },
      h('legend', { class: 'sr-only' }, 'Reader'),
      h('div', { class: 'choice', id: 'choice-regex' },
        h('label', { class: 'choice-row', for: 'reader-regex' }, rRegex,
          h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, 'Regex reader only'), h('span', { class: 'help' }, 'Fast. The model is not used to read tickets, but it can still reword the staff briefs when it is running.')))),
      h('div', { class: 'choice', id: 'choice-model' },
        h('label', { class: 'choice-row', for: 'reader-model' }, rModel,
          h('span', { class: 'choice-text' },
            h('span', { class: 'choice-title' }, 'Regex + local model', modelName),
            h('span', { class: 'help' }, 'Reads the tickets the regex reader is unsure about and writes the briefs.'))),
        modelExtra),
      h('div', { class: 'choice', id: 'choice-none' },
        h('label', { class: 'choice-row', for: 'reader-none' }, rNone,
          h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, 'No model at all'), h('span', { class: 'help' }, 'Strictly model-free: regex reader and briefs written from the records only. The model is never contacted for this run.'))))),
    h('details', { class: 'advanced', open: !!ui.limit },
      h('summary', null, icon('chev-down', 'icon-sm chev'), 'Advanced: ticket limit'),
      h('div', { class: 'field adv-body' }, h('label', { class: 'label', for: 'limit' }, 'Ticket limit'), limitInput, limitHelp)));

  const modelUsable = () => !!S.model?.usable;
  const effectiveReader = () => (ui.reader === 'none' ? 'none' : ui.reader === 'model' ? (modelUsable() ? 'model' : 'regex') : ui.reader === 'regex' ? 'regex' : (modelUsable() ? 'model' : 'regex'));

  async function checkAgain(btn) {
    if (ui.checking) return;
    ui.checking = true; renderReader();
    try { await refreshModel(true); } finally { ui.checking = false; if (alive) renderReader(); }
  }

  function renderReader() {
    const usable = modelUsable();
    const eff = effectiveReader();
    rRegex.checked = eff === 'regex';
    rModel.checked = eff === 'model';
    rNone.checked = eff === 'none';
    rModel.disabled = !usable;
    modelName.textContent = S.model?.model || '';
    modelName.hidden = !S.model?.model;
    document.getElementById('choice-model')?.classList.toggle('disabled', !usable);
    if (usable) { fill(modelExtra); modelExtra.hidden = true; return; }
    modelExtra.hidden = false;
    const known = !!S.model;
    fill(modelExtra,
      h('span', { class: 'choice-status', role: 'status' }, icon('alert', 'icon-sm'), known ? (S.model.error || 'The local model is not available.') : 'Checking the local model…'),
      h('span', { class: 'choice-links' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: ui.checking, onclick: (e) => checkAgain(e.currentTarget) }, ui.checking ? h('span', { class: 'spinner spinner-sm' }) : icon('refresh'), ui.checking ? 'Checking…' : 'Check again'),
        h('a', { class: 'btn btn-sm btn-quiet', href: href('settings') }, 'Local model settings')));
  }

  // ------------------------------------------------------------------ summary + start
  function limitValid() { return ui.limit === '' || /^[1-9]\d*$/.test(ui.limit); }
  function total() {
    const v = ui.validation;
    if (!v?.ok) return 0;
    return ui.limit && limitValid() ? Math.min(+ui.limit, v.tickets) : v.tickets;
  }
  function activeInfo() {
    if (S.run && ACTIVE.includes(S.progress.status)) return { id: S.runId, label: S.run.label };
    const a = ui.activeRun;
    if (a && !(a.id === S.runId && !ACTIVE.includes(S.progress.status))) return a;
    return null;
  }

  function renderSummary() {
    const v = ui.validation;
    const n = total();
    const model = effectiveReader() === 'model';
    const readerTxt = model ? `Regex + ${S.model?.model || 'local model'}` : effectiveReader() === 'none' ? 'Regex reader, no model at all' : 'Regex reader';
    const est = !n ? 'Not known yet' : model ? `About ${fmtDuration(n * 3.6)}` : 'Under a minute';
    fill(summaryBody, h('dl', { class: 'kv nr-kv' },
      h('dt', null, 'Dataset'), h('dd', { class: 'truncate', title: ui.path || null }, v?.ok ? `${folderName(ui.path)} (${plural(n, 'ticket')})` : h('span', { class: 'muted' }, 'Not chosen yet')),
      h('dt', null, 'Reader'), h('dd', null, readerTxt),
      h('dt', null, 'Estimate'), h('dd', null, est)),
      h('p', { class: 'help nr-note' }, 'You can start reviewing while it runs, and stop it at any time.'));
  }

  function renderBanner() {
    const a = activeInfo();
    fill(bannerSlot, a ? banner({
      tone: 'info', role: 'status', title: 'A run is already in progress.',
      actions: h('a', { class: 'btn btn-sm', href: href('overview', { runId: a.id }) }, 'View progress'),
    }) : null);
    return a;
  }

  function renderStart() {
    const a = activeInfo();
    const n = total();
    const ok = !!ui.validation?.ok && !ui.validating && limitValid();
    let reason = '';
    if (a) reason = 'A run is already in progress.';
    else if (!ui.path) reason = 'Choose a dataset folder first.';
    else if (ui.validating) reason = 'Checking the folder…';
    else if (!ui.validation?.ok) reason = 'Choose a valid dataset folder first.';
    else if (!limitValid()) reason = 'Ticket limit must be a whole number of 1 or more.';
    startBtn.disabled = !ok || !!a || ui.submitting;
    startBtn.title = reason || '';
    reasonLine.textContent = !ui.submitting && startBtn.disabled ? reason : '';
    limitInput.setAttribute('aria-invalid', limitValid() ? 'false' : 'true');
    limitHelp.textContent = limitValid() ? 'Process only the first N tickets, for a quick trial. Leave empty for all.' : 'Enter a whole number of 1 or more, or leave empty for all.';
    fill(startBtn, ui.submitting ? h('span', { class: 'spinner' }) : icon('play'), ui.submitting ? 'Starting…' : ok && n ? `Start run on ${plural(n, 'ticket')}` : 'Start run');
    fill(errorSlot, ui.startError ? banner({ tone: 'danger', role: 'alert', title: 'Could not start the run', text: ui.startError }) : null);
  }

  function renderAll() { renderReader(); renderSummary(); renderBanner(); renderStart(); }

  async function start() {
    if (ui.submitting || startBtn.disabled) return;
    ui.submitting = true; ui.startError = null; renderStart();
    const useModel = effectiveReader() === 'model';
    const modelFree = effectiveReader() === 'none';
    try {
      const { run_id } = await api.startRun({ path: ui.path, use_model: useModel, model_free: modelFree, limit: ui.limit && limitValid() ? +ui.limit : null });
      navigate(href('overview', { runId: run_id }));
    } catch (e) {
      ui.submitting = false;
      ui.startError = e.message || 'Something went wrong. Try again.';
      if (alive) { renderStart(); errorSlot.firstChild?.scrollIntoView?.({ block: 'nearest' }); }
    }
  }

  off.push(on((kind) => { if (kind === 'model' || kind === 'progress' || kind === 'run') renderAll(); }));
  (async () => {
    renderValidation(); renderAll();
    if (!ui.path) {
      try { const l = await api.fsList(''); if (alive && !ui.path) { ui.path = l.shortcuts?.[0]?.path || ''; input.value = ui.path; } } catch { /* leave empty */ }
    }
    if (!alive) return;
    renderValidation(); renderAll();
    if (ui.path) validate();
    refreshModel();
    try {
      const d = await api.runs();
      const a = (d.runs || []).find((r) => ACTIVE.includes(r.status));
      if (alive) { ui.activeRun = a ? { id: a.id, label: a.label } : null; renderAll(); }
    } catch { /* the server will refuse a second run with its own message */ }
  })();

  return { destroy() { alive = false; off.forEach((f) => f()); validateSoon.cancel(); vSeq++; } };
}

// ---------------------------------------------------------------------------- folder browser dialog
function openFolderPicker(startPath, onPick) {
  let listing = null;
  let useBtn;
  const pathInput = h('input', { class: 'input mono', type: 'text', 'aria-label': 'Folder path', spellcheck: 'false' });
  const shortcuts = h('div', { class: 'row-wrap' });
  const list = h('ul', { class: 'folder-list', 'aria-label': 'Subfolders' });
  const note = h('div', { 'aria-live': 'polite' });
  const upBtn = h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Up one folder', onclick: () => listing && browse(listing.parent) }, icon('arrow-up'));

  async function browse(p) {
    try {
      listing = await api.fsList(p || '');
      pathInput.value = listing.path;
      upBtn.disabled = !listing.path;
      fill(shortcuts, (listing.shortcuts || []).map((s) => h('button', { class: 'chip', type: 'button', onclick: () => browse(s.path) }, s.name)));
      fill(list, listing.entries.length
        ? listing.entries.map((e) => h('li', null, h('button', { class: 'folder-item', type: 'button', onclick: () => browse(e.path) },
          icon(e.has_tickets ? 'folder-check' : listing.path ? 'folder' : 'drive'), h('span', { class: 'name truncate', title: e.name }, e.name),
          e.has_tickets ? h('span', { class: 'badge badge-accent' }, 'Dataset') : null, icon('chev-right', 'icon-sm'))))
        : h('li', { class: 'folder-empty muted' }, 'No subfolders here.'));
      fill(note, listing.is_dataset ? h('span', { class: 'badge badge-success' }, icon('check'), 'This folder looks like a dataset') : null);
      useBtn.disabled = !listing.path;
    } catch (e) { fill(note, h('span', { class: 'badge badge-danger', role: 'alert' }, icon('circle-alert'), e.message || 'Cannot open that folder')); }
  }

  // Arrow keys move between folders; Enter/click opens the focused one.
  list.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.folder-item')];
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: items[i + 1] || items[0], ArrowUp: items[i - 1] || items[items.length - 1], Home: items[0], End: items[items.length - 1] }[e.key];
    if (to && i >= 0) { e.preventDefault(); to.focus(); }
  });

  const dlg = openDialog({
    title: 'Choose dataset folder', width: 600,
    body: () => h('div', { class: 'stack' }, h('div', { class: 'input-row' }, upBtn, pathInput), shortcuts, list, note),
    actions: (d) => {
      useBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, onclick: () => { onPick(listing.path); d.close(); } }, 'Use this folder');
      return [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'), useBtn];
    },
  });
  dlg.classList.add('picker-dialog');
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); browse(pathInput.value.trim()); } });
  browse(startPath);
}

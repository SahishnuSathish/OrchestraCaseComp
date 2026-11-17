// New run: choose a dataset folder, validate it, pick reader options, start. The run itself is watched on its Overview.
import { h, icon, mount as fill, debounce, ls, fmtDuration, plural } from '../lib.js';
import { api } from '../api.js';
import { S, on, refreshModel } from '../state.js';
import { openDialog, toast, pageHeader, panel } from '../ui.js';
import { href, navigate } from '../router.js';

const ACTIVE = ['starting', 'running'];

export function mount(root, { route }) {
  const q = route.query || {};
  const ui = {
    path: q.dataset || ls('ap.dataset') || '', validation: null, validating: false, submitting: false,
    useModel: q.model === '1' ? true : q.model === '0' ? false : null,
    limit: /^[1-9]\d*$/.test(q.limit || '') ? q.limit : '',
  };
  const off = [];

  const datasetBody = h('div', { class: 'stack' });
  const optionsBody = h('div', { class: 'stack' });
  fill(root, h('div', { class: 'page' },
    pageHeader({
      title: 'New run', back: { label: 'Runs', href: href('runs') },
      meta: 'Pick the dataset folder, then run every ticket through the pipeline. Replies are drafted for you to approve in Review; nothing is sent.',
    }),
    h('div', { class: 'page-grid' },
      panel({ title: 'Dataset folder', icon: 'folder', body: datasetBody }),
      panel({ title: 'Reader options', icon: 'cpu', body: optionsBody }))));

  // ------------------------------------------------------------------ dataset
  const input = h('input', { class: 'input mono', id: 'dataset-path', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'C:\\path\\to\\dataset', 'aria-describedby': 'dataset-status', value: ui.path });
  const validationBox = h('div', { id: 'dataset-status', 'aria-live': 'polite' });
  const browseBtn = h('button', { class: 'btn', type: 'button', onclick: () => openFolderPicker(ui.path, (p) => setPath(p, true)) }, icon('folder'), 'Browse\u2026');
  fill(datasetBody,
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'dataset-path' }, 'Folder'), h('div', { class: 'input-row' }, input, browseBtn),
      h('p', { class: 'help' }, 'The folder that holds tickets.json and the vendor, employee, bill, payment and payment-run CSVs.')),
    validationBox);

  function setPath(p, immediate) {
    ui.path = p; input.value = p; ls('ap.dataset', p);
    immediate ? validate() : validateSoon();
  }
  const validateSoon = debounce(() => validate(), 400);
  input.addEventListener('input', () => { ui.path = input.value.trim(); ui.validating = true; renderValidation(); renderRun(); validateSoon(); });
  input.addEventListener('change', () => ls('ap.dataset', ui.path));

  let vSeq = 0;
  async function validate() {
    const seq = ++vSeq;
    if (!ui.path) { ui.validation = null; ui.validating = false; renderValidation(); renderRun(); return; }
    ui.validating = true; renderValidation();
    try {
      const v = await api.validate(ui.path);
      if (seq !== vSeq) return;
      ui.validation = v;
    } catch (e) { if (seq !== vSeq) return; ui.validation = { ok: false, error: e.message, files: [] }; }
    ui.validating = false;
    renderValidation(); renderRun();
  }

  function renderValidation() {
    const v = ui.validation;
    if (ui.validating) return fill(validationBox, h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), 'Checking folder\u2026'));
    if (!ui.path) return fill(validationBox, h('p', { class: 'muted' }, 'Choose a folder to begin.'));
    if (!v) return fill(validationBox);
    const items = (v.files || []).map((f) => {
      const cls = f.status === 'ok' ? 'ok' : f.status === 'absent' ? 'absent' : f.required ? 'bad' : 'warn';
      const ic = f.status === 'ok' ? 'circle-check' : f.status === 'absent' ? 'circle-dash' : f.required ? 'circle-x' : 'circle-alert';
      return h('li', { class: `check ${cls}` }, icon(ic), h('span', { class: 'name truncate' }, f.name), h('span', { class: 'detail' }, f.detail));
    });
    fill(validationBox,
      h('div', { class: 'stack-sm' },
        v.ok
          ? h('div', { class: 'row' }, h('span', { class: 'badge badge-success' }, icon('check'), 'Ready'), h('span', null, `${plural(v.tickets, 'ticket')} found`, v.has_answer_key ? ' \u00b7 answer key present, so results can be scored' : ''))
          : h('div', { class: 'banner banner-danger', role: 'alert' }, icon('circle-alert'), h('div', null, h('strong', null, v.error || 'This folder cannot be used'), v.exists && h('span', null, 'Fix the missing items below, or pick another folder.'))),
        items.length ? h('ul', { class: 'checklist' }, items) : null));
  }

  // ------------------------------------------------------------------ options + start
  const limitInput = h('input', { class: 'input', id: 'limit', type: 'number', inputmode: 'numeric', min: '1', placeholder: 'All', 'aria-describedby': 'limit-help', value: ui.limit });
  limitInput.addEventListener('input', () => { ui.limit = limitInput.value; renderRunButton(); });
  const modelInput = h('input', { type: 'checkbox', id: 'use-model' });
  modelInput.addEventListener('change', () => { ui.useModel = modelInput.checked; renderRunButton(); });
  const modelHelp = h('span', { class: 'help' });
  const runRow = h('div', { class: 'run-actions' });
  fill(optionsBody,
    h('div', { class: 'opt-grid' },
      h('label', { class: 'switch', for: 'use-model' }, modelInput, h('span', { class: 'switch-track' }),
        h('span', { class: 'switch-text' }, h('span', { class: 'label' }, 'Use the local model as a second reader'), modelHelp)),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'limit' }, 'Ticket limit'), limitInput, h('span', { class: 'help', id: 'limit-help' }, 'Optional. Leave empty for all.'))),
    runRow);

  function renderRun() {
    const m = S.model;
    const usable = !!m?.usable;
    if (ui.useModel === null) ui.useModel = usable;
    modelInput.disabled = !usable;
    modelInput.checked = usable && ui.useModel;
    modelHelp.textContent = usable
      ? `${m.model} on this computer. Briefs are also written by it, then checked against the records.`
      : 'Not available right now, so the pipeline will use its regex reader and briefs come from the records.';
    renderRunButton();
  }

  function renderRunButton() {
    const running = ACTIVE.includes(S.progress.status);
    const v = ui.validation;
    const total = v?.ok ? (ui.limit && +ui.limit > 0 ? Math.min(+ui.limit, v.tickets) : v.tickets) : 0;
    const useModel = !!(S.model?.usable && ui.useModel);
    const est = !total ? '' : useModel ? `About ${fmtDuration(total * 3.6)} with the model` : 'Under a minute without the model';
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: !v?.ok || ui.validating || running || ui.submitting, onclick: () => start(useModel) },
      ui.submitting ? h('span', { class: 'spinner' }) : icon('play'), ui.submitting ? 'Starting\u2026' : total ? `Run on ${plural(total, 'ticket')}` : 'Run pipeline');
    fill(runRow, btn, h('span', { class: 'est' }, running ? 'A run is in progress.' : est));
  }

  async function start(useModel) {
    if (ui.submitting) return;
    ui.submitting = true; renderRunButton();
    try {
      const { run_id } = await api.startRun({ path: ui.path, use_model: useModel, limit: ui.limit && +ui.limit > 0 ? +ui.limit : null });
      navigate(href('overview', { runId: run_id }));
    } catch (e) {
      ui.submitting = false; renderRunButton();
      toast({ message: e.message || 'Could not start the run', duration: 6000 });
    }
  }

  off.push(on((kind) => { if (kind === 'model') renderRun(); else if (kind === 'progress') renderRunButton(); }));
  (async () => {
    if (!ui.path) {
      try { const l = await api.fsList(''); if (!ui.path) { ui.path = l.shortcuts?.[0]?.path || ''; input.value = ui.path; } } catch { /* leave empty */ }
    }
    renderValidation(); renderRun();
    if (ui.path) validate();
    refreshModel();
  })();

  return { destroy() { off.forEach((f) => f()); validateSoon.cancel(); vSeq++; } };
}

// ---------------------------------------------------------------------------- folder browser dialog
function openFolderPicker(startPath, onPick) {
  let listing = null;
  const pathInput = h('input', { class: 'input mono', type: 'text', 'aria-label': 'Folder path', spellcheck: 'false' });
  const shortcuts = h('div', { class: 'row-wrap' });
  const list = h('div', { class: 'folder-list', role: 'list' });
  const note = h('div', { 'aria-live': 'polite' });
  const upBtn = h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Up one folder', onclick: () => listing && browse(listing.parent) }, icon('arrow-up'));
  let useBtn;

  async function browse(p) {
    try {
      listing = await api.fsList(p || '');
      pathInput.value = listing.path;
      upBtn.disabled = !listing.path;
      fill(shortcuts, (listing.shortcuts || []).map((s) => h('button', { class: 'chip', type: 'button', onclick: () => browse(s.path) }, s.name)));
      fill(list, listing.entries.length
        ? listing.entries.map((e) => h('button', { class: 'folder-item', type: 'button', role: 'listitem', onclick: () => browse(e.path) },
          icon(e.has_tickets ? 'folder-check' : listing.path ? 'folder' : 'drive'), h('span', { class: 'name truncate' }, e.name),
          e.has_tickets ? h('span', { class: 'badge badge-accent' }, 'Dataset') : null, icon('chev-right', 'icon-sm')))
        : h('div', { class: 'panel-body muted' }, 'No subfolders here.'));
      fill(note, listing.is_dataset ? h('span', { class: 'badge badge-success' }, icon('check'), 'This folder looks like a dataset') : null);
      useBtn.disabled = !listing.path;
    } catch (e) { fill(note, h('span', { class: 'badge badge-danger' }, icon('circle-alert'), e.message || 'Cannot open that folder')); }
  }

  openDialog({
    title: 'Choose dataset folder', width: 600,
    body: () => h('div', { class: 'stack' },
      h('div', { class: 'input-row' }, upBtn, pathInput),
      shortcuts, list, note),
    actions: (dlg) => {
      useBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { onPick(listing.path); dlg.close(); } }, 'Use this folder');
      return [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), useBtn];
    },
  });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); browse(pathInput.value.trim()); } });
  browse(startPath);
}

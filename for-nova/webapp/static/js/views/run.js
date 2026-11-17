// Run view: choose a dataset folder, validate it, run the pipeline on every ticket, watch it stream, then go review.
import { h, icon, mount as fill, clear, debounce, ls, go, fmtInt, fmtMs, fmtDuration, relTime, plural, humanize } from '../lib.js';
import { api } from '../api.js';
import { S, on, loadRun, refreshModel } from '../state.js';
import { openDialog, outputBadge, emptyState, toast } from '../ui.js';

const ACTIVE = ['starting', 'running'];

export function mount(root) {
  const ui = { path: ls('ap.dataset') || '', validation: null, validating: false, useModel: null, limit: '' };
  let off = [];

  const page = h('div', { class: 'page' });
  const head = h('div', { class: 'page-head' }, h('h1', null, 'Run the pipeline'),
    h('p', null, 'Pick the dataset folder, then run every ticket through the pipeline. Replies are drafted for you to approve in Review; nothing is sent.'));
  const datasetBody = h('div', { class: 'card-body stack' });
  const optionsBody = h('div', { class: 'card-body stack' });
  const progressSlot = h('div');
  const summarySlot = h('div');
  const side = h('div', { class: 'stack' });

  const left = h('div', { class: 'stack' },
    h('section', { class: 'card', 'aria-labelledby': 'h-dataset' }, h('div', { class: 'card-head' }, h('span', { class: 'step' }, '1'), h('h2', { id: 'h-dataset' }, 'Dataset folder')), datasetBody),
    h('section', { class: 'card', 'aria-labelledby': 'h-run' }, h('div', { class: 'card-head' }, h('span', { class: 'step' }, '2'), h('h2', { id: 'h-run' }, 'Run')), optionsBody),
    progressSlot, summarySlot);
  page.append(head, h('div', { class: 'run-grid' }, left, side));
  fill(root, page);

  // ------------------------------------------------------------------ dataset card
  const input = h('input', { class: 'input mono', id: 'dataset-path', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'C:\\path\\to\\dataset', 'aria-describedby': 'dataset-status', value: ui.path });
  const validationBox = h('div', { id: 'dataset-status', 'aria-live': 'polite' });
  const browseBtn = h('button', { class: 'btn', type: 'button', onclick: () => openFolderPicker(ui.path, (p) => setPath(p, true)) }, icon('folder'), 'Browse…');
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
    if (ui.validating) return fill(validationBox, h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), 'Checking folder…'));
    if (!ui.path) return fill(validationBox, h('p', { class: 'muted' }, 'Choose a folder to begin.'));
    if (!v) return fill(validationBox);
    const items = (v.files || []).map((f) => {
      const cls = f.status === 'ok' ? 'ok' : f.status === 'absent' ? 'absent' : f.required ? 'bad' : 'warn';
      const ic = f.status === 'ok' ? 'circle-check' : f.status === 'absent' ? 'circle-dash' : f.required ? 'circle-x' : 'circle-alert';
      return h('li', { class: `check ${cls}` }, icon(ic), h('span', { class: 'name truncate' }, f.name),
        h('span', { class: 'detail' }, f.status === 'ok' ? f.detail : f.required ? f.detail : f.detail));
    });
    fill(validationBox,
      h('div', { class: 'stack-sm' },
        v.ok
          ? h('div', { class: 'row' }, h('span', { class: 'badge badge-success' }, icon('check'), 'Ready'), h('span', null, `${plural(v.tickets, 'ticket')} found`, v.has_answer_key ? ' · answer key present, so results can be scored' : ''))
          : h('div', { class: 'banner banner-danger', role: 'alert' }, icon('circle-alert'), h('div', null, h('strong', null, v.error || 'This folder cannot be used'), v.exists && h('span', null, 'Fix the missing items below, or pick another folder.'))),
        items.length ? h('ul', { class: 'checklist' }, items) : null));
  }

  // ------------------------------------------------------------------ run card
  const limitInput = h('input', { class: 'input', id: 'limit', type: 'number', inputmode: 'numeric', min: '1', placeholder: 'All', 'aria-describedby': 'limit-help' });
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
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: !v?.ok || ui.validating || running, onclick: () => start(useModel) },
      icon('play'), total ? `Run on ${plural(total, 'ticket')}` : 'Run pipeline');
    fill(runRow, btn, h('span', { class: 'est' }, running ? 'A run is in progress.' : est));
  }

  async function start(useModel) {
    try {
      const { run_id } = await api.startRun({ path: ui.path, use_model: useModel, limit: ui.limit && +ui.limit > 0 ? +ui.limit : null });
      liveRows = [];
      await loadRun(run_id);
      renderAll();
    } catch (e) { toast({ message: e.message || 'Could not start the run', duration: 6000 }); }
  }

  // ------------------------------------------------------------------ progress card
  let liveRows = [];
  const liveList = h('div', { class: 'live-list', role: 'log', 'aria-label': 'Tickets as they finish' });
  const nowLine = h('div', { class: 'now' });
  const barFill = h('div', { class: 'bar-fill' });
  const big = h('span', { class: 'big' });
  const small = h('span', { class: 'small' });
  const cancelBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { cancelBtn.disabled = true; try { await api.cancelRun(S.runId); } catch (e) { toast({ message: e.message }); } } }, icon('stop'), 'Stop');
  const progressCard = h('section', { class: 'card', 'aria-label': 'Run progress' },
    h('div', { class: 'card-head' }, h('span', { class: 'step' }, '3'), h('h2', null, 'Progress'), h('div', { style: { marginLeft: 'auto' } }, cancelBtn)),
    h('div', { class: 'card-body' },
      h('div', { class: 'progress-top' }, big, small),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, barFill), nowLine, liveList));
  progressCard.querySelector('.bar').id = 'run-bar';

  function liveRowEl(r, animate = true) {
    const el = h('a', { class: 'live-row', href: `#/tickets/${r.ticket_id}`, style: animate ? null : { animation: 'none' } },
      h('span', { class: 'mono faint' }, `#${r.ticket_id}`),
      h('span', { class: 'truncate' }, r.subject || ''),
      h('span', { class: 'rule mono faint truncate' }, r.rule || ''),
      h('span', null, outputBadge(r.output_type)),
      h('span', { class: 'ms' }, fmtMs(r.ms)));
    return el;
  }

  function renderProgress(newRow) {
    const p = S.progress;
    const active = ACTIVE.includes(p.status);
    const show = active || (p.status === 'failed') || (p.status === 'cancelled' && p.done < p.total);
    if (!show) { fill(progressSlot); return; }
    if (!progressSlot.firstChild) { progressSlot.append(progressCard); progressCard.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
    const frac = p.total ? p.done / p.total : 0;
    big.textContent = `${fmtInt(p.done)} / ${fmtInt(p.total)}`;
    const per = p.done ? p.elapsed / p.done : 0;
    const eta = p.done && p.status === 'running' ? ` · about ${fmtDuration(per * (p.total - p.done))} left` : '';
    small.textContent = p.status === 'running' ? `${fmtDuration(p.elapsed)} elapsed · ${per ? per.toFixed(1) : '–'} s per ticket${eta}` : p.status === 'starting' ? 'Loading records…' : humanize(p.status);
    barFill.style.transform = `scaleX(${frac})`;
    progressCard.querySelector('.bar').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    cancelBtn.hidden = !active;
    cancelBtn.disabled = false;
    clear(nowLine);
    if (p.status === 'failed') nowLine.append(icon('circle-alert'), h('span', { style: { color: 'var(--danger)' } }, p.error || 'The run failed.'));
    else if (p.status === 'cancelled') nowLine.append(icon('circle-dash'), `Stopped after ${plural(p.done, 'ticket')}. Results so far are kept.`);
    else if (p.working) nowLine.append(h('span', { class: 'dot dot-live' }), h('span', { class: 'truncate' }, `Working on #${p.working.ticket_id} · ${p.working.subject || ''}`));
    for (const w of p.warnings || []) nowLine.append(h('span', { class: 'badge badge-warning' }, icon('alert'), w));
    if (newRow) {
      liveList.prepend(liveRowEl(newRow));
      while (liveList.children.length > 100) liveList.lastChild.remove();
    }
    liveList.hidden = !liveList.children.length;
  }

  function seedLive() {
    clear(liveList);
    for (const r of [...S.rows].reverse().slice(0, 100)) liveList.append(liveRowEl(r, false));
  }

  // ------------------------------------------------------------------ summary card
  function renderSummary() {
    const run = S.run, p = S.progress;
    if (!run || ACTIVE.includes(p.status) || !['done', 'cancelled', 'interrupted'].includes(run.status) || !run.counts.total) { fill(summarySlot); return; }
    const c = run.counts;
    const segs = [['seg-reply', 'Draft reply', c.draft_reply], ['seg-note', 'Internal note', c.internal_action_note], ['seg-none', 'No reply', c.no_draft], ['seg-error', 'Failed', c.error]].filter((s) => s[2] > 0);
    const sec = run.finished_at && run.started_at ? run.finished_at - run.started_at : p.elapsed;
    fill(summarySlot, h('section', { class: 'card', 'aria-labelledby': 'h-done' },
      h('div', { class: 'card-head' }, icon('circle-check', 'icon-lg'), h('h2', { id: 'h-done' }, `${plural(c.total, 'ticket')} processed`),
        sec ? h('span', { class: 'faint', style: { marginLeft: 'auto', fontSize: 'var(--fs-sm)' } }, `${fmtDuration(sec)}${run.use_model ? ' · local model on' : ' · no model'}`) : null),
      h('div', { class: 'card-body' },
        h('div', { class: 'stackbar', role: 'img', 'aria-label': segs.map((s) => `${s[1]} ${s[2]}`).join(', ') }, segs.map(([cls, , n]) => h('span', { class: cls, style: { flex: `${n} 1 0` } }))),
        h('div', { class: 'legend', style: { marginTop: 'var(--s-3)' } }, segs.map(([cls, label, n]) => h('div', { class: 'legend-item' }, h('span', { class: `legend-swatch ${cls}` }), h('b', null, n), label))),
        h('div', { class: 'summary-grid' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Most common outcomes'),
            h('ul', { class: 'rule-list' }, (c.rules || []).slice(0, 6).map(([rule, n]) => h('li', null, h('span', { class: 'mono' }, rule), h('b', null, n))))),
          h('div', null, h('div', { class: 'eyebrow' }, 'Needs attention'),
            h('ul', { class: 'rule-list' },
              h('li', null, h('span', { class: 'row' }, icon('shield-alert', 'icon-sm'), 'Flagged as fraud'), h('b', null, c.flagged)),
              h('li', null, h('span', { class: 'row' }, icon('flag', 'icon-sm'), 'Priority'), h('b', null, c.priority)),
              h('li', null, h('span', { class: 'row' }, icon('circle-alert', 'icon-sm'), 'Failed to process'), h('b', null, c.error)))))),
      h('div', { class: 'card-foot row-wrap' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go('#/review') }, icon('review'), `Review drafts (${fmtInt(c.draft_reply)})`),
        h('button', { class: 'btn', type: 'button', onclick: () => go('#/tickets') }, icon('tickets'), 'Open tickets'))));
  }

  // ------------------------------------------------------------------ recent runs
  async function renderRecent() {
    let data;
    try { data = await api.runs(); } catch { return; }
    const runs = data.runs || [];
    const saved = data.importable || [];
    fill(side,
      h('section', { class: 'card', 'aria-labelledby': 'h-recent' },
        h('div', { class: 'card-head' }, h('h2', { id: 'h-recent' }, 'Recent runs')),
        runs.length ? runs.map((r) => h('div', { class: 'run-item' },
          h('div', { class: 'meta' }, h('div', { class: 'name truncate' }, r.label || r.id),
            h('div', { class: 'sub' }, `${plural(r.counts.total, 'ticket')} · ${r.use_model ? 'model' : 'no model'} · ${relTime(r.created_at)}${ACTIVE.includes(r.status) ? ' · running' : r.status === 'interrupted' ? ' · interrupted' : ''}`)),
          r.id === S.runId ? h('span', { class: 'badge badge-accent' }, 'Open') : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openRun(r.id) }, 'Open')))
          : h('div', { class: 'card-body muted' }, 'No runs yet. Your first run will appear here.')),
      saved.length ? h('section', { class: 'card', 'aria-labelledby': 'h-saved' },
        h('div', { class: 'card-head' }, h('h2', { id: 'h-saved' }, 'Saved results on disk')),
        saved.map((s) => h('div', { class: 'run-item' },
          h('div', { class: 'meta' }, h('div', { class: 'name mono truncate' }, `out/${s.name}`), h('div', { class: 'sub' }, `bundles.json · ${s.size_kb} KB · ${relTime(s.modified)}`)),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => importSaved(s, e.currentTarget) }, 'Open')))) : null);
  }

  async function openRun(id) {
    try { await loadRun(id); go('#/tickets'); } catch (e) { toast({ message: e.message }); }
  }
  async function importSaved(s, btn) {
    btn.disabled = true; btn.textContent = 'Opening…';
    try { const { run_id } = await api.importRun(s.path); await loadRun(run_id); go('#/tickets'); }
    catch (e) { toast({ message: e.message || 'Could not open that result set' }); btn.disabled = false; btn.textContent = 'Open'; }
  }

  // ------------------------------------------------------------------ wiring
  function renderAll() { renderValidation(); renderRun(); renderProgress(); renderSummary(); renderRecent(); }
  off.push(on((kind, data) => {
    if (kind === 'ticket') renderProgress(data);
    else if (kind === 'progress') { renderProgress(); renderRunButton(); if (!ACTIVE.includes(S.progress.status)) { renderSummary(); renderRecent(); } }
    else if (kind === 'run') { renderSummary(); renderRecent(); }
    else if (kind === 'model') renderRun();
  }));

  (async () => {
    if (!ui.path) {
      try { const l = await api.fsList(''); ui.path = l.shortcuts?.[0]?.path || ''; input.value = ui.path; } catch { /* leave empty */ }
    }
    if (ACTIVE.includes(S.progress.status)) seedLive();
    renderAll();
    if (ui.path) validate();
    refreshModel();
  })();

  return { destroy() { off.forEach((f) => f()); validateSoon.cancel(); } };
}

// ---------------------------------------------------------------------------- folder browser dialog
function openFolderPicker(startPath, onPick) {
  let listing = null;
  const pathInput = h('input', { class: 'input mono', type: 'text', 'aria-label': 'Folder path', spellcheck: 'false' });
  const shortcuts = h('div', { class: 'row-wrap' });
  const list = h('div', { class: 'folder-list', role: 'list' });
  const note = h('div', { 'aria-live': 'polite' });
  const upBtn = h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Up one folder', onclick: () => listing && go_(listing.parent) }, icon('arrow-up'));
  let useBtn;

  async function go_(p) {
    try {
      listing = await api.fsList(p || '');
      pathInput.value = listing.path;
      upBtn.disabled = !listing.path;
      fill(shortcuts, (listing.shortcuts || []).map((s) => h('button', { class: 'chip', type: 'button', onclick: () => go_(s.path) }, s.name)));
      fill(list, listing.entries.length
        ? listing.entries.map((e) => h('button', { class: 'folder-item', type: 'button', role: 'listitem', onclick: () => go_(e.path) },
          icon(e.has_tickets ? 'folder-check' : listing.path ? 'folder' : 'drive'), h('span', { class: 'name truncate' }, e.name),
          e.has_tickets ? h('span', { class: 'badge badge-accent' }, 'Dataset') : null, icon('chev-right', 'icon-sm')))
        : h('div', { class: 'card-body muted' }, 'No subfolders here.'));
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
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go_(pathInput.value.trim()); } });
  go_(startPath);
}

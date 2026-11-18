// Run overview: status and live progress while the run works, then outcomes, review progress and the way into Tickets/Review.
// Numbers are derived from S.rows and written into persistent nodes, so a streaming run never rebuilds the page.
import { h, icon, mount as fill, clear, fmtInt, fmtMs, fmtDuration, plural, relTime } from '../lib.js';
import { api } from '../api.js';
import { S, on, isActive, forgetRun } from '../state.js';
import { outputBadge, toast, pageHeader, panel, statTile, menuButton, banner } from '../ui.js';
import { href, navigate } from '../router.js';
import { statusBadge, readerText, shortDate, fullDate, runAgainHref, pathLine, deleteRunFlow } from './runs.js';

const SIGNED_OFF = new Set(['approved', 'sent', 'acknowledged', 'closed']);
const SEGMENTS = [
  ['draft_reply', 'Draft reply', 'seg-reply'],
  ['internal_action_note', 'Internal note', 'seg-note'],
  ['no_draft', 'No reply', 'seg-none'],
  ['error', 'Failed', 'seg-failed'],
];

export function mount(root) {
  const runId = S.runId;
  const off = [];
  let alive = true;
  let stopping = false;
  let exporting = false;
  let rafId = 0;
  const upgrading = new Set(); // ticket ids whose briefs we asked the model to rewrite

  const run = () => (S.run && S.run.id === runId ? S.run : null);
  const status = () => (S.progress.status === 'idle' ? run()?.status : S.progress.status);
  const active = () => ACTIVE.includes(status());
  const ACTIVE_LIST = ['starting', 'running'];
  const q = (rows, f) => rows.filter(f).length;

  // ------------------------------------------------------------------ header (built once, updated in place)
  const badgeSlot = h('span', { class: 'title-badge' });
  const metaText = h('span');
  const pathSlot = h('span', { class: 'path-slot' });
  const menuSlot = h('span', { class: 'menu-slot' });
  const exportBtn = h('button', { class: 'btn', type: 'button', onclick: () => doExport('signed_off') }, icon('download'), 'Export');
  const browseLink = h('a', { class: 'btn', href: href('tickets', { runId }) }, icon('tickets'), 'Browse tickets');
  const reviewLink = h('a', { class: 'btn btn-primary', href: href('review', { runId }) }, icon('review'), 'Review');
  const againLink = h('a', { class: 'btn btn-primary', href: '#' }, icon('rotate'), 'Run again');
  const initial = run();
  const header = pageHeader({
    title: [h('span', { class: 'ov-title' }, initial?.label || 'Run'), badgeSlot], back: { label: 'Runs', href: href('runs') },
    meta: [metaText, pathSlot],
    actions: [menuSlot, exportBtn, browseLink, reviewLink, againLink],
  });

  let menuSig = '';
  function renderMenu() {
    const r = run();
    if (!r) return;
    const zero = !S.rows.length && !active();
    const act = active();
    const sig = `${zero}|${act}`;
    if (sig === menuSig) return;
    menuSig = sig;
    const items = [];
    if (!zero) {
      items.push({ label: 'Run again', icon: 'rotate', onSelect: () => navigate(runAgainHref(run())) });
      items.push({ label: 'Export all results (including unreviewed)', icon: 'download', onSelect: () => doExport('all') });
    }
    items.push({ label: 'Delete run…', icon: 'trash', danger: true, disabled: act, title: act ? 'Stop the run before deleting it' : null, onSelect: onDelete });
    fill(menuSlot, menuButton({ label: 'More actions', icon: 'more', items }));
  }

  async function doExport(scope) {
    if (exporting) return;
    exporting = true; renderHeader();
    try {
      await api.download(`/api/runs/${runId}/export?scope=${scope}`, `${run()?.label || runId}-${scope === 'all' ? 'all' : 'signed-off'}.json`);
    } catch (e) { toast({ message: e.message || 'Could not export the results', duration: 6000 }); }
    exporting = false;
    if (alive) renderHeader();
  }

  async function onDelete() {
    const r = run();
    if (!r || !(await deleteRunFlow(r))) return;
    navigate(href('runs'));
    forgetRun();
  }

  function renderHeader() {
    const r = run();
    if (!r) return;
    const st = status();
    const badge = statusBadge(st);
    badgeSlot.replaceChildren(...(badge ? [badge] : []));
    const rows = S.rows;
    const total = active() ? (S.progress.total || r.total || 0) : (r.counts?.total ?? rows.length);
    const took = r.finished_at && r.started_at ? r.finished_at - r.started_at : 0;
    const started = r.started_at || r.created_at;
    const parts = [plural(total, 'ticket'), readerText(r)];
    parts.push(active() ? `started ${relTime(started)}` : `started ${shortDate(started)}`);
    if (st === 'done' && took) parts.push(`took ${fmtDuration(took)}`);
    metaText.textContent = parts.join(' · ');
    metaText.title = fullDate(started);
    pathSlot.replaceChildren(r.dataset_path ? pathLine(r.dataset_path) : '');

    const zero = !rows.length && !active();
    const pending = rows.filter((x) => x.output_type === 'draft_reply' && x.review_state === 'pending').length;
    exportBtn.hidden = browseLink.hidden = reviewLink.hidden = zero;
    againLink.hidden = !zero;
    againLink.href = runAgainHref(r);
    const signed = rows.filter((x) => x.output_type !== 'error' && SIGNED_OFF.has(x.review_state)).length;
    exportBtn.disabled = exporting || signed === 0;
    exportBtn.title = signed === 0 ? 'Nothing has been approved, acknowledged or closed yet' : 'Export approved, acknowledged and closed results';
    fill(exportBtn, exporting ? h('span', { class: 'spinner spinner-sm' }) : icon('download'), exporting ? 'Exporting…' : 'Export');
    fill(reviewLink, icon('review'), pending ? `Review drafts (${fmtInt(pending)})` : 'Review');
    renderMenu();
  }

  // ------------------------------------------------------------------ banners
  const bannerSlot = h('div', { class: 'ov-banners' });
  let bannerSig = '';
  function renderBanners() {
    const r = run();
    if (!r) return;
    const st = status();
    const p = S.progress;
    const warnings = [...new Set([...(r.warnings || []), ...(p.warnings || [])])];
    const err = st === 'failed' ? (p.error || r.error || '') : '';
    const sig = JSON.stringify([st, warnings, err, st === 'cancelled' ? [p.done, p.total] : 0]);
    if (sig === bannerSig) return;
    bannerSig = sig;
    const again = () => h('a', { class: 'btn btn-sm', href: runAgainHref(run() || r) }, icon('rotate'), 'Run again');
    const out = warnings.map((w) => banner({ tone: 'warning', role: 'status', text: w }));
    if (st === 'failed') out.push(banner({ tone: 'danger', role: 'alert', title: 'This run failed', text: err || 'No further details were reported.', actions: again() }));
    else if (st === 'interrupted') out.push(banner({ tone: 'warning', role: 'status', title: 'This run was interrupted because Conductor stopped.', text: 'Results so far are kept.', actions: again() }));
    else if (st === 'cancelled') out.push(banner({ tone: 'info', role: 'status', title: `This run was stopped after ${fmtInt(p.done || r.done)} of ${fmtInt(p.total || r.total)} tickets.`, text: 'Results so far are kept.', actions: again() }));
    fill(bannerSlot, out);
  }

  // ------------------------------------------------------------------ progress panel
  const liveList = h('div', { class: 'live-list', role: 'log', 'aria-label': 'Tickets as they finish' });
  const nowLine = h('div', { class: 'now' });
  const barFill = h('div', { class: 'bar-fill' });
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Run progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, barFill);
  const big = h('span', { class: 'big' });
  const small = h('span', { class: 'small' });
  const announce = h('span', { class: 'sr-only', role: 'status' });
  const stopBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: onStop });
  const progressPanel = panel({
    title: 'Progress', icon: 'run', actions: stopBtn,
    body: [h('div', { class: 'progress-top' }, big, small), bar, nowLine, liveList, announce],
  });
  const progressSlot = h('div');
  let liveSeeded = false;
  const liveIds = new Set();
  let lastStatus = null;
  let elapsedBase = { v: 0, at: 0, done: -1 };

  async function onStop() {
    if (stopping) return;
    stopping = true; renderProgress();
    try { await api.cancelRun(runId); }
    catch (e) { stopping = false; toast({ message: e.message || 'Could not stop the run', duration: 6000 }); renderProgress(); }
  }

  function liveRowEl(r, animate = true) {
    return h('a', { class: 'live-row', dataset: { tid: r.ticket_id }, href: href('tickets', { runId, ticketId: r.ticket_id }), style: animate ? null : { animation: 'none' } },
      h('span', { class: 'mono faint' }, `#${r.ticket_id}`),
      h('span', { class: 'truncate', title: r.subject || null }, r.subject || ''),
      h('span', { class: 'rule mono faint truncate' }, r.rule || ''),
      h('span', { class: 'live-out' }, outputBadge(r.output_type)),
      h('span', { class: 'ms' }, fmtMs(r.ms)));
  }

  function renderProgress() {
    const r = run();
    if (!r) return;
    const st = status();
    const p = S.progress;
    const act = ACTIVE_LIST.includes(st);
    const partial = ['failed', 'cancelled', 'interrupted'].includes(st) && p.total > 0 && p.done > 0 && p.done < p.total;
    if (!act) stopping = false;
    if (!(act || partial)) {
      if (progressSlot.firstChild) { progressSlot.replaceChildren(); liveSeeded = false; liveIds.clear(); clear(liveList); }
      if (lastStatus && lastStatus !== st) announceStatus(st);
      lastStatus = st;
      return;
    }
    if (!progressSlot.firstChild) progressSlot.append(progressPanel);
    if (!liveSeeded) {
      liveSeeded = true;
      clear(liveList); liveIds.clear();
      for (const x of [...S.rows].reverse().slice(0, 100)) { liveIds.add(x.ticket_id); liveList.append(liveRowEl(x, false)); }
    }
    if (lastStatus !== st) { if (lastStatus) announceStatus(st); lastStatus = st; }
    const frac = p.total ? Math.min(1, p.done / p.total) : 0;
    big.textContent = `${fmtInt(p.done)} / ${fmtInt(p.total)}`;
    bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    bar.setAttribute('aria-valuetext', `${fmtInt(p.done)} of ${fmtInt(p.total)} tickets`);
    barFill.style.transform = `scaleX(${frac})`;
    renderProgressText();
    stopBtn.hidden = !act;
    stopBtn.disabled = stopping;
    fill(stopBtn, stopping ? h('span', { class: 'spinner spinner-sm' }) : icon('stop'), stopping ? 'Stopping…' : 'Stop run');
    clear(nowLine);
    if (st === 'failed') nowLine.append(icon('circle-alert'), h('span', { class: 'now-danger' }, p.error || 'The run failed.'));
    else if (st === 'cancelled') nowLine.append(icon('circle-dash'), `Stopped after ${plural(p.done, 'ticket')}. Results so far are kept.`);
    else if (st === 'interrupted') nowLine.append(icon('alert'), `Interrupted after ${plural(p.done, 'ticket')}. Results so far are kept.`);
    else if (stopping) nowLine.append(h('span', { class: 'spinner spinner-sm' }), 'Stopping after the current ticket finishes.');
    else if (p.working) nowLine.append(h('span', { class: 'dot dot-live' }), h('span', { class: 'truncate' }, `Working on #${p.working.ticket_id}${p.working.subject ? ` · ${p.working.subject}` : ''}`));
    else nowLine.append(h('span', { class: 'dot dot-live' }), st === 'starting' ? 'Loading records…' : 'Working…');
    liveList.hidden = !liveList.children.length;
  }

  function announceStatus(st) {
    announce.textContent = { done: 'Run finished', cancelled: 'Run stopped', failed: 'Run failed', interrupted: 'Run interrupted', running: 'Run started' }[st] || '';
  }

  // elapsed only arrives with each ticket; between tickets keep the clock moving
  function renderProgressText() {
    const p = S.progress;
    const st = status();
    if (!progressSlot.firstChild) return;
    if (p.elapsed !== elapsedBase.v || p.done !== elapsedBase.done) elapsedBase = { v: p.elapsed, at: performance.now(), done: p.done };
    if (st === 'running') {
      const elapsed = elapsedBase.v + (performance.now() - elapsedBase.at) / 1000;
      const per = p.done ? elapsedBase.v / p.done : 0;
      const eta = p.done >= 3 ? ` · about ${fmtDuration(per * (p.total - p.done))} left` : '';
      small.textContent = `${fmtDuration(elapsed)} elapsed${per ? ` · ${per.toFixed(1)} s per ticket` : ''}${eta}`;
    } else if (st === 'starting') small.textContent = 'Starting…';
    else small.textContent = p.elapsed >= 1 ? `${fmtDuration(p.elapsed)} elapsed` : '';
  }
  const clock = setInterval(() => { if (alive && active()) renderProgressText(); }, 1000);

  // ------------------------------------------------------------------ stat tiles
  const tiles = {
    total: statTile({ label: 'Tickets', value: '0', icon: 'tickets', href: href('tickets', { runId }) }),
    reply: statTile({ label: 'Draft replies', value: '0', icon: 'mail', href: href('tickets', { runId, query: { output: 'draft_reply' } }) }),
    note: statTile({ label: 'Internal notes', value: '0', icon: 'file', href: href('tickets', { runId, query: { output: 'internal_action_note' } }) }),
    none: statTile({ label: 'No reply', value: '0', icon: 'circle-dash', href: href('tickets', { runId, query: { output: 'no_draft' } }) }),
    flagged: statTile({ label: 'Flagged', value: '0', icon: 'shield-alert', href: href('tickets', { runId, query: { flagged: 1 } }) }),
    priority: statTile({ label: 'Priority', value: '0', icon: 'flag', href: href('tickets', { runId, query: { priority: 1 } }) }),
    failed: statTile({ label: 'Failed', value: '0', icon: 'circle-alert', tone: 'danger', href: href('tickets', { runId, query: { output: 'error' } }) }),
  };
  const val = (t) => t.querySelector('.stat-value');
  const statGrid = h('div', { class: 'stat-grid', role: 'group', 'aria-label': 'Ticket counts' }, Object.values(tiles));

  // ------------------------------------------------------------------ outcomes panel
  const segEls = SEGMENTS.map(([, label, cls]) => h('span', { class: `seg ${cls}` }));
  const stackbar = h('div', { class: 'ov-stackbar', role: 'img' }, segEls);
  const legendEls = SEGMENTS.map(([, label, cls]) => {
    const n = h('b', { class: 'num' });
    return { el: h('li', { class: 'legend-item' }, h('span', { class: `legend-swatch ${cls}`, 'aria-hidden': 'true' }), n, label), n };
  });
  const legend = h('ul', { class: 'legend ov-legend' }, legendEls.map((l) => l.el));
  const waiting = h('p', { class: 'muted ov-waiting' });
  const rulesHead = h('div', { class: 'eyebrow' }, 'Most common rules');
  const rulesList = h('ul', { class: 'rule-list' });
  const rulesBlock = h('div', { class: 'ov-rules' }, rulesHead, rulesList);
  const outcomesBody = h('div', { class: 'stack' }, waiting, stackbar, legend, rulesBlock);
  const outcomesPanel = panel({ title: 'Outcomes', icon: 'layers', body: outcomesBody });
  let ruleSig = '';
  const ruleEls = new Map();

  function renderOutcomes(rows) {
    const total = rows.length;
    waiting.hidden = total > 0;
    waiting.textContent = active() ? 'Waiting for the first ticket…' : 'No tickets were processed.';
    stackbar.hidden = legend.hidden = rulesBlock.hidden = !total;
    const counts = SEGMENTS.map(([k]) => q(rows, (r) => r.output_type === k));
    const labels = [];
    SEGMENTS.forEach(([, label], i) => {
      const n = counts[i];
      segEls[i].hidden = n === 0;
      segEls[i].style.flex = `${n} 1 0`;
      segEls[i].title = `${label}: ${fmtInt(n)} of ${fmtInt(total)}`;
      legendEls[i].n.textContent = fmtInt(n);
      legendEls[i].el.hidden = SEGMENTS[i][0] === 'error' && n === 0;
      if (n) labels.push(`${label} ${n}`);
    });
    stackbar.setAttribute('aria-label', `Outcomes of ${fmtInt(total)} tickets: ${labels.join(', ')}`);

    const byRule = new Map();
    for (const r of rows) if (r.rule) byRule.set(r.rule, (byRule.get(r.rule) || 0) + 1);
    const top = [...byRule].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
    const nextSig = top.map((t) => t[0]).join('|');
    if (nextSig !== ruleSig) {
      ruleSig = nextSig;
      ruleEls.clear();
      fill(rulesList, top.map(([rule]) => {
        const n = h('b', { class: 'num' });
        ruleEls.set(rule, n);
        return h('li', null, h('a', { class: 'rule-link', href: href('tickets', { runId, query: { q: rule } }) },
          h('span', { class: 'mono truncate', title: rule }, rule), n, icon('chev-right', 'icon-sm')));
      }));
    }
    for (const [rule, n] of top) ruleEls.get(rule).textContent = fmtInt(n);
  }

  // ------------------------------------------------------------------ review progress panel
  const rvHead = h('p', { class: 'rv-head' });
  const rvBarFill = h('div', { class: 'bar-fill' });
  const rvBar = h('div', { class: 'bar', role: 'img' }, rvBarFill);
  const rvNone = h('p', { class: 'muted' });
  const rvRow = (label, query, extra = false) => {
    const n = h('span', { class: 'num rv-n' });
    const sub = extra ? h('span', { class: 'faint rv-sub' }) : null;
    const a = h('a', { class: 'rp-row', href: href('review', { runId, query }) }, h('span', { class: 'rp-label' }, label), sub, n, icon('chev-right', 'icon-sm'));
    return { a, n, sub };
  };
  const rowTodo = rvRow('To review', {});
  const rowApproved = rvRow('Approved', { tab: 'approved' }, true);
  const rowReturned = rvRow('Returned', { tab: 'returned' });
  const rowNotes = rvRow('Notes handled', { tab: 'notes' });
  const rvList = h('div', { class: 'rp-list' }, rowTodo.a, rowApproved.a, rowReturned.a, rowNotes.a);
  const reviewPanel = panel({ title: 'Review progress', icon: 'review', body: h('div', { class: 'stack-sm' }, rvHead, rvBar, rvNone, rvList) });

  function renderReview(rows) {
    const drafts = rows.filter((r) => r.output_type === 'draft_reply');
    const notes = rows.filter((r) => r.output_type === 'internal_action_note');
    const st = (r) => r.review_state || 'pending';
    const approved = q(drafts, (r) => st(r) === 'approved');
    const sent = q(drafts, (r) => st(r) === 'sent');
    const returned = q(drafts, (r) => st(r) === 'returned');
    const todo = q(drafts, (r) => st(r) === 'pending');
    const done = approved + sent + returned;
    const handled = q(notes, (r) => st(r) === 'acknowledged' || st(r) === 'closed');
    const has = drafts.length > 0;
    rvHead.hidden = rvBar.hidden = !has;
    rvNone.hidden = has;
    rvNone.textContent = active() ? 'Drafted replies appear here as tickets are processed.' : 'This run drafted no replies.';
    rowTodo.a.hidden = rowApproved.a.hidden = rowReturned.a.hidden = !has;
    rowNotes.a.hidden = !notes.length;
    rvHead.textContent = `${fmtInt(done)} of ${fmtInt(drafts.length)} drafts reviewed`;
    rvBarFill.style.transform = `scaleX(${drafts.length ? done / drafts.length : 0})`;
    rvBar.setAttribute('aria-label', rvHead.textContent);
    rowTodo.n.textContent = fmtInt(todo);
    rowApproved.n.textContent = fmtInt(approved);
    rowApproved.sub.textContent = sent ? `· ${fmtInt(sent)} sent` : '';
    rowReturned.n.textContent = fmtInt(returned);
    rowNotes.n.textContent = `${fmtInt(handled)} of ${fmtInt(notes.length)}`;
  }

  // ------------------------------------------------------------------ briefs panel
  const bModel = h('li');
  const bTemplate = h('li');
  const bAction = h('div', { class: 'briefs-action' });
  const briefsPanel = panel({ title: 'Briefs', icon: 'cpu', body: h('div', { class: 'stack-sm' }, h('ul', { class: 'briefs-counts' }, bModel, bTemplate), bAction) });
  let briefSig = '';

  async function rewrite(btn) {
    const ids = S.rows.filter((r) => r.brief_source !== 'model').map((r) => r.ticket_id);
    btn.disabled = true;
    try {
      await api.upgradeBriefs(runId);
      ids.forEach((i) => upgrading.add(i));
    } catch (e) { toast({ message: e.message || 'Could not start rewriting the briefs', duration: 6000 }); }
    scheduleRender(true);
  }

  function renderBriefs(rows) {
    const fromModel = q(rows, (r) => r.brief_source === 'model');
    const rest = rows.length - fromModel;
    const pendingN = S.model?.briefs_pending > 0 ? S.model.briefs_pending : upgrading.size;
    const modelFree = !!S.run?.model_free;
    const usable = !!S.model?.usable && !modelFree;
    const sig = [fromModel, rest, pendingN, usable, modelFree, active()].join('|');
    briefsPanel.hidden = !rows.length;
    if (sig === briefSig) return;
    briefSig = sig;
    bModel.textContent = `${fmtInt(fromModel)} written by the local model`;
    bTemplate.textContent = `${fmtInt(rest)} generated from records`;
    if (pendingN > 0) fill(bAction, h('p', { class: 'row muted', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), `Rewriting ${plural(pendingN, 'brief')} in the background…`));
    else if (rest > 0 && usable && !active()) fill(bAction, h('button', { class: 'btn', type: 'button', onclick: (e) => rewrite(e.currentTarget) }, icon('refresh'), 'Rewrite the rest with the local model'));
    else if (rest > 0 && modelFree) fill(bAction, h('p', { class: 'muted' }, 'This run used no model, so every brief is generated from the records.'));
    else if (rest > 0 && !usable) fill(bAction, h('p', { class: 'muted' }, 'The local model is not available, so briefs are generated from the records. ', h('a', { href: href('settings') }, 'Local model settings')));
    else fill(bAction);
  }

  // ------------------------------------------------------------------ assembly + updates
  const aside = h('div', { class: 'ov-aside' }, reviewPanel, briefsPanel);
  const sections = [bannerSlot, progressSlot, statGrid, h('div', { class: 'page-grid two' }, outcomesPanel, aside)];
  fill(root, h('div', { class: 'page ov' }, header, h('div', { class: 'page-grid' }, sections)));

  function renderStats(rows) {
    val(tiles.total).textContent = fmtInt(rows.length);
    val(tiles.reply).textContent = fmtInt(q(rows, (r) => r.output_type === 'draft_reply'));
    val(tiles.note).textContent = fmtInt(q(rows, (r) => r.output_type === 'internal_action_note'));
    val(tiles.none).textContent = fmtInt(q(rows, (r) => r.output_type === 'no_draft'));
    const flagged = q(rows, (r) => (r.flags || []).length > 0);
    const priority = q(rows, (r) => r.priority);
    const failed = q(rows, (r) => r.output_type === 'error');
    val(tiles.flagged).textContent = fmtInt(flagged);
    val(tiles.priority).textContent = fmtInt(priority);
    val(tiles.failed).textContent = fmtInt(failed);
    tiles.flagged.classList.toggle('tone-danger', flagged > 0);
    tiles.priority.classList.toggle('tone-warning', priority > 0);
    tiles.failed.hidden = failed === 0;
  }

  function renderBody() {
    if (!run()) return;
    const rows = S.rows;
    const empty = !rows.length && !active();
    statGrid.hidden = outcomesPanel.parentElement.hidden = empty;
    renderStats(rows);
    renderOutcomes(rows);
    renderReview(rows);
    renderBriefs(rows);
  }

  function renderAll() {
    if (!run()) return;
    renderHeader(); renderBanners(); renderProgress(); renderBody();
  }

  function scheduleRender(force) {
    if (force) { cancelAnimationFrame(rafId); rafId = 0; renderAll(); return; }
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; if (alive) renderAll(); });
  }

  off.push(on((kind, data) => {
    if (!alive || !run()) return;
    if (kind === 'ticket') {
      if (liveSeeded && data && !liveIds.has(data.ticket_id)) {
        liveIds.add(data.ticket_id);
        liveList.prepend(liveRowEl(data));
        while (liveList.children.length > 100) { const last = liveList.lastChild; liveIds.delete(Number(last.dataset.tid)); last.remove(); }
        liveList.hidden = false;
      }
      scheduleRender();
    } else if (kind === 'brief') {
      if (data) upgrading.delete(data.ticket_id);
      scheduleRender();
    } else if (kind === 'model') {
      if (S.model && S.model.briefs_pending === 0) upgrading.clear();
      scheduleRender();
    } else if (['progress', 'run', 'review'].includes(kind)) scheduleRender();
  }));
  renderAll();

  return {
    update() { scheduleRender(); },
    destroy() { alive = false; cancelAnimationFrame(rafId); clearInterval(clock); off.forEach((f) => f()); },
  };
}

const ACTIVE = ['starting', 'running'];

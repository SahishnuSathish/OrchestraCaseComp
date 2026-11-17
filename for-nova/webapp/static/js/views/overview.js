// Run overview: status and live progress while the run works, then the outcome summary and the way into Review/Tickets.
import { h, icon, mount as fill, clear, fmtInt, fmtMs, fmtDuration, plural, humanize } from '../lib.js';
import { api } from '../api.js';
import { S, on, isActive } from '../state.js';
import { outputBadge, toast, pageHeader, panel } from '../ui.js';
import { href } from '../router.js';

const STATUS_BADGE = {
  starting: ['badge-accent', 'play', 'Starting'], running: ['badge-accent', 'play', 'Running'], failed: ['badge-danger', 'circle-alert', 'Failed'],
  cancelled: ['', 'circle-dash', 'Stopped'], interrupted: ['badge-warning', 'alert', 'Interrupted'],
};

export function mount(root) {
  const runId = S.runId;
  const off = [];
  const headSlot = h('div');
  const progressSlot = h('div');
  const summarySlot = h('div');
  fill(root, h('div', { class: 'page' }, headSlot, h('div', { class: 'page-grid' }, progressSlot, summarySlot)));

  function renderHead() {
    const run = S.run;
    const st = STATUS_BADGE[S.progress.status === 'idle' ? run.status : S.progress.status];
    fill(headSlot, pageHeader({
      title: run.label || 'Run', back: { label: 'Runs', href: href('runs') },
      meta: run.dataset_path ? h('span', { class: 'mono', title: run.dataset_path }, run.dataset_path) : null,
      badges: st ? h('span', { class: `badge ${st[0]}` }, icon(st[1]), st[2]) : null,
    }));
  }

  // ------------------------------------------------------------------ progress
  const liveList = h('div', { class: 'live-list', role: 'log', 'aria-label': 'Tickets as they finish' });
  const nowLine = h('div', { class: 'now' });
  const barFill = h('div', { class: 'bar-fill' });
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Run progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, barFill);
  const big = h('span', { class: 'big' });
  const small = h('span', { class: 'small' });
  const cancelBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { cancelBtn.disabled = true; try { await api.cancelRun(S.runId); } catch (e) { toast({ message: e.message }); } } }, icon('stop'), 'Stop');
  const progressPanel = panel({
    title: 'Progress', icon: 'run', actions: cancelBtn,
    body: [h('div', { class: 'progress-top' }, big, small), bar, nowLine, liveList],
  });

  function liveRowEl(r, animate = true) {
    return h('a', { class: 'live-row', href: href('tickets', { runId, ticketId: r.ticket_id }), style: animate ? null : { animation: 'none' } },
      h('span', { class: 'mono faint' }, `#${r.ticket_id}`),
      h('span', { class: 'truncate' }, r.subject || ''),
      h('span', { class: 'rule mono faint truncate' }, r.rule || ''),
      h('span', null, outputBadge(r.output_type)),
      h('span', { class: 'ms' }, fmtMs(r.ms)));
  }

  function renderProgress(newRow) {
    const p = S.progress;
    const active = isActive({ status: p.status });
    const show = active || p.status === 'failed' || (p.status === 'cancelled' && p.done < p.total);
    if (!show) { fill(progressSlot); return; }
    if (!progressSlot.firstChild) { progressSlot.append(progressPanel); seedLive(); }
    const frac = p.total ? p.done / p.total : 0;
    big.textContent = `${fmtInt(p.done)} / ${fmtInt(p.total)}`;
    const per = p.done ? p.elapsed / p.done : 0;
    const eta = p.done && p.status === 'running' ? ` · about ${fmtDuration(per * (p.total - p.done))} left` : '';
    small.textContent = p.status === 'running' ? `${fmtDuration(p.elapsed)} elapsed · ${per ? per.toFixed(1) : '–'} s per ticket${eta}` : p.status === 'starting' ? 'Loading records…' : humanize(p.status);
    barFill.style.transform = `scaleX(${frac})`;
    bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
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

  // ------------------------------------------------------------------ summary
  function renderSummary() {
    const run = S.run, p = S.progress;
    if (!run || isActive({ status: p.status }) || !['done', 'cancelled', 'interrupted'].includes(run.status) || !run.counts.total) { fill(summarySlot); return; }
    const c = run.counts;
    const segs = [['seg-reply', 'Draft reply', c.draft_reply], ['seg-note', 'Internal note', c.internal_action_note], ['seg-none', 'No reply', c.no_draft], ['seg-error', 'Failed', c.error]].filter((s) => s[2] > 0);
    const sec = run.finished_at && run.started_at ? run.finished_at - run.started_at : p.elapsed;
    fill(summarySlot, panel({
      title: `${plural(c.total, 'ticket')} processed`, icon: 'circle-check',
      actions: sec ? h('span', { class: 'faint', style: { fontSize: 'var(--fs-sm)' } }, `${fmtDuration(sec)}${run.use_model ? ' · local model on' : ' · no model'}`) : null,
      body: [
        h('div', { class: 'stackbar', role: 'img', 'aria-label': segs.map((s) => `${s[1]} ${s[2]}`).join(', ') }, segs.map(([cls, , n]) => h('span', { class: cls, style: { flex: `${n} 1 0` } }))),
        h('div', { class: 'legend', style: { marginTop: 'var(--s-3)' } }, segs.map(([cls, label, n]) => h('div', { class: 'legend-item' }, h('span', { class: `legend-swatch ${cls}` }), h('b', null, n), label))),
        h('div', { class: 'summary-grid' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Most common outcomes'),
            h('ul', { class: 'rule-list' }, (c.rules || []).slice(0, 6).map(([rule, n]) => h('li', null, h('span', { class: 'mono' }, rule), h('b', null, n))))),
          h('div', null, h('div', { class: 'eyebrow' }, 'Needs attention'),
            h('ul', { class: 'rule-list' },
              h('li', null, h('span', { class: 'row' }, icon('shield-alert', 'icon-sm'), 'Flagged as fraud'), h('b', null, c.flagged)),
              h('li', null, h('span', { class: 'row' }, icon('flag', 'icon-sm'), 'Priority'), h('b', null, c.priority)),
              h('li', null, h('span', { class: 'row' }, icon('circle-alert', 'icon-sm'), 'Failed to process'), h('b', null, c.error)))))],
      foot: [
        h('a', { class: 'btn btn-primary', href: href('review', { runId }) }, icon('review'), `Review drafts (${fmtInt(c.draft_reply)})`),
        h('a', { class: 'btn', href: href('tickets', { runId }) }, icon('tickets'), 'Open tickets')],
    }));
  }

  function renderAll() { renderHead(); renderProgress(); renderSummary(); }
  off.push(on((kind, data) => {
    if (kind === 'ticket') renderProgress(data);
    else if (kind === 'progress') { renderHead(); renderProgress(); if (!isActive({ status: S.progress.status })) renderSummary(); }
    else if (kind === 'run') { renderHead(); renderSummary(); }
  }));
  renderAll();

  return { update() {}, destroy() { off.forEach((f) => f()); } };
}

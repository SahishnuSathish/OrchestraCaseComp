// Scheduled send controls, in the inbox composer (views/inbox.js mounts them under the action bar of an approved reply). mountSchedule
// is cheap: the schedule is fetched at most once per ticket (and after our own actions), and the DOM is only
// rebuilt when what it shows has changed. Times are shown in local time and sent to the server in UTC.
import { h, icon, mount } from './lib.js';
import { toast } from './components/overlays.js';

export const MIN_AHEAD_MS = 60 * 1000;
export const MAX_AHEAD_MS = 30 * 24 * 3600 * 1000;

// ---------------------------------------------------------------------------- pure helpers (tested in node)
const pad = (n) => String(n).padStart(2, '0');

/** A Date as the value of a datetime-local input, in local time: YYYY-MM-DDTHH:mm. */
export function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (local time) as a UTC ISO string without milliseconds, or null if it is not a time. */
export function localInputToUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value || '')) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A UTC ISO string as a datetime-local value in local time. */
export function utcToLocalInput(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : toLocalInput(d);
}

/** Why a send time is not allowed, or null. At least 1 minute ahead, at most 30 days ahead. */
export function windowError(date, now = Date.now()) {
  const t = date instanceof Date ? date.getTime() : NaN;
  if (Number.isNaN(t)) return 'Pick a date and time.';
  if (t < now + MIN_AHEAD_MS) return 'Pick a time at least 1 minute from now.';
  if (t > now + MAX_AHEAD_MS) return 'Pick a time within the next 30 days.';
  return null;
}

/** Check a datetime-local value. Returns { utc, error }. */
export function checkInput(value, now = Date.now()) {
  const utc = localInputToUtc(value);
  if (!utc) return { utc: null, error: 'Pick a date and time.' };
  const error = windowError(new Date(utc), now);
  return { utc: error ? null : utc, error };
}

/** A UTC ISO string in local time, for people: "Nov 17, 9:00 AM". */
export function formatLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function mailHint(mode) {
  return mode === 'smtp'
    ? 'Conductor must be running at that time. The reply goes out through the mail server then.'
    : 'Simulated mail: the .eml file appears in the outbox at that time. Conductor must be running.';
}

// ---------------------------------------------------------------------------- state
const cache = new Map(); // "runId:ticketId" -> { data, loading, busy, error }
let apiPromise = null;
const api = () => (apiPromise ||= import('./api-schedule.js'));  // loaded on first use; keeps the helpers above importable in node

const keyOf = (runId, ticketId) => `${runId}:${ticketId}`;

export function mountSchedule(el, ctx) {
  if (!el) return;
  const { runId, ticketId, detail } = ctx;
  const key = keyOf(runId, ticketId);
  const eligible = detail?.draft?.output_type === 'draft_reply' && detail.review?.state === 'approved' && detail.review.can_send;
  el.__ctx = ctx;
  if (!eligible) {                       // not approved, or already sent: whatever we knew is stale
    cache.delete(key);
    if (el.__sig !== '') { mount(el); el.__sig = ''; }
    return;
  }
  let entry = cache.get(key);
  if (!entry) {
    entry = { data: null, loading: true, busy: false, error: null };
    cache.set(key, entry);
    api().then((m) => m.getSchedule(runId, ticketId))
      .then((data) => { entry.data = data; }, () => { entry.data = { schedule: null, mail_mode: detail.mail?.mode }; })
      .then(() => { entry.loading = false; if (cache.get(key) === entry) draw(el); });
  }
  draw(el);
}

function draw(el, force = false) {
  const ctx = el.__ctx;
  if (!ctx) return;
  const { runId, ticketId, detail } = ctx;
  const entry = cache.get(keyOf(runId, ticketId));
  if (!entry || entry.loading) { if (el.__sig !== '') { mount(el); el.__sig = ''; } return; }
  const s = entry.data?.schedule;
  const mode = entry.data?.mail_mode || detail.mail?.mode;
  const sig = [runId, ticketId, s?.status, s?.send_at, s?.last_error, mode, entry.busy, entry.error].join('|');
  if (!force && el.__sig === sig) return; // nothing to change: keeps the picker's value while someone types elsewhere
  el.__sig = sig;
  mount(el, build(el, ctx, entry, s, mode));
}

function build(el, ctx, entry, s, mode) {
  const { runId, ticketId } = ctx;
  const busy = entry.busy;
  const act = async (fn) => {
    entry.busy = true; entry.error = null; draw(el);
    try { entry.data = await fn(await api()); } catch (e) { entry.error = e.message || 'Could not change the schedule.'; }
    entry.busy = false; draw(el, true);
    return !entry.error;
  };
  const hint = h('p', { class: 'sched-hint' }, mailHint(mode));
  const error = entry.error ? h('p', { class: 'sched-error', role: 'alert' }, entry.error) : null;

  if (s?.status === 'scheduled') {
    return h('div', { class: 'schedule', role: 'group', 'aria-label': 'Scheduled send' },
      h('span', { class: 'sched-label' }, icon('clock', 'icon-sm'), 'Scheduled for ', h('span', { class: 'sched-when' }, formatLocal(s.send_at))),
      h('div', { class: 'sched-actions' },
        h('button', { class: 'c-btn c-btn-secondary c-btn-sm', type: 'button', disabled: busy, onclick: () => act((m) => m.cancelSchedule(runId, ticketId)) }, 'Cancel schedule')),
      s.last_error ? h('p', { class: 'sched-hint' }, `Last try failed: ${s.last_error} It will try again.`) : null,
      error, hint);
  }

  const now = serverNow(entry);
  const input = h('input', { class: 'c-input sched-input', type: 'datetime-local', id: 'schedule-at', 'aria-label': 'Send date and time, in your local time',
    value: toLocalInput(new Date(now + 3600 * 1000)), min: toLocalInput(new Date(now + MIN_AHEAD_MS)), max: toLocalInput(new Date(now + MAX_AHEAD_MS)) });
  const go = async () => {
    const { utc, error: bad } = checkInput(input.value, serverNow(entry));
    if (bad) { entry.error = bad; draw(el, true); return; }
    if (await act((m) => m.setSchedule(runId, ticketId, utc))) toast({ message: `Scheduled for ${formatLocal(utc)}` });
  };
  const note = s?.status === 'missed' ? h('span', { class: 'sched-note' }, icon('circle-alert', 'icon-sm'), 'Missed. It was not sent. Pick a new time.')
    : s?.status === 'failed' ? h('span', { class: 'sched-note' }, icon('circle-alert', 'icon-sm'), `Scheduled send failed: ${s.last_error || 'unknown error'}`)
      : s?.status === 'cancelled' && s.last_error && s.last_error !== 'Cancelled by a person.' ? h('span', { class: 'sched-note is-quiet' }, icon('info', 'icon-sm'), `Schedule cancelled: ${s.last_error}`)
        : null;
  return h('div', { class: 'schedule', role: 'group', 'aria-label': 'Schedule send' },
    h('label', { class: 'sched-label', for: 'schedule-at' }, icon('clock', 'icon-sm'), 'Send later'),
    input,
    h('div', { class: 'sched-actions' }, h('button', { class: 'c-btn c-btn-primary c-btn-sm', type: 'button', disabled: busy, onclick: go }, 'Schedule send')),
    note, error, hint);
}

// The app runs on the server's clock (the snapshot date with the real time of day, CONTRACTS section 4). The schedule
// payload carries the server's `now`, so the picker's default, its limits and the check use that clock, not this computer's date.
function serverNow(entry) {
  const t = Date.parse(entry?.data?.now || '');
  if (Number.isNaN(t)) return Date.now();
  if (entry.skew == null) entry.skew = t - Date.now();
  return Date.now() + entry.skew;
}

/** Forget what we know about every ticket. */
export function resetScheduleCache() { cache.clear(); }

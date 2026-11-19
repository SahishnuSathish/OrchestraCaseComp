// Hash router: pure parse/href/crumbs, plus navigate() for the two history modes.
// Workspace routes: #/inbox[/:ticketId], #/escalations[/:ticketId], #/team, #/approver, #/ahead, #/vendor-setup[/:vendorId],
// #/settings, #/settings/advanced, #/connections, #/styleguide. The run-era routes (#/runs...) still parse, and links into
// a run's tickets or review redirect: to #/inbox/<id> when the run is the inbox run, otherwise to Settings, Advanced.
// Nothing here touches the DOM; location/history/storage are only read inside functions, so the module imports in Node.

const RUN_ID = /^[0-9a-f]{8}$/;
const TICKET_ID = /^[1-9][0-9]*$/;
const SCOPES = ['tickets', 'review'];
const FLAG_KEYS = ['flagged', 'priority'];
const DEFAULTS = { sort: 'seq', tab: 'todo', dir: 'asc' };
const INBOX_RUN_KEY = 'conductor.inboxRun';
const SESSION_KEY = 'conductor.session';
const HOMES = { ap_specialist: '#/inbox', cfo: '#/escalations', approver: '#/approver' };

/** The last batch run this browser opened (localStorage `ap.run`). */
export function lastRunId() {
  try { return globalThis.localStorage?.getItem('ap.run') || null; } catch { return null; }
}

/** The inbox run id this tab has seen (views/inbox.js records it). null until known. */
export function knownInboxRunId() {
  try { return globalThis.sessionStorage?.getItem(INBOX_RUN_KEY) || null; } catch { return null; }
}
/** Remember the inbox run id so old run links can be redirected without a request. */
export function rememberInboxRunId(id) {
  try { if (id && RUN_ID.test(id)) globalThis.sessionStorage?.setItem(INBOX_RUN_KEY, id); } catch { /* storage blocked */ }
}

function sessionRole() {
  try { return JSON.parse(globalThis.sessionStorage?.getItem(SESSION_KEY) || 'null')?.role || null; } catch { return null; }
}
/** The home hash for a role: '#/inbox' (specialists), '#/escalations' (CFO), '#/approver' (approvers). */
export function homeHash(role = sessionRole()) { return HOMES[role] || '#/inbox'; }

function parseQuery(qs) {
  const query = {};
  if (!qs) return query;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
    const key = dec(eq < 0 ? part : part.slice(0, eq));
    if (key) query[key] = eq < 0 ? '' : dec(part.slice(eq + 1));
  }
  return query;
}

function queryString(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === '' || v === false) continue;
    if (FLAG_KEYS.includes(k) && (!v || v === '0')) continue;
    if (DEFAULTS[k] === v) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const notFound = (query) => ({ name: 'not-found', query });

// parse('#/inbox/41259') -> { name:'inbox', ticketId:41259, query:{} }
// `redirect` is set for empty and legacy hashes; the shell applies it with replace.
// opts: { role, inboxRunId } override what this tab has stored (tests pass them).
// When the inbox run id is not known yet, a run's tickets/review link keeps its route and the tickets/review view
// finishes the redirect after asking the server.
export function parse(hash, opts = {}) {
  const raw = String(hash || '').replace(/^#/, '');
  const qAt = raw.indexOf('?');
  const path = (qAt < 0 ? raw : raw.slice(0, qAt)).replace(/^\/+/, '').replace(/\/+$/, '');
  const query = parseQuery(qAt < 0 ? '' : raw.slice(qAt + 1));
  const seg = path ? path.split('/') : [];
  const [a, b, c, d] = seg;
  const inboxRun = opts.inboxRunId !== undefined ? opts.inboxRunId : knownInboxRunId();

  // An empty hash (and the old "#/run") opens this person's home.
  if (!seg.length || (a === 'run' && seg.length === 1)) return { name: 'home', query, redirect: homeHash(opts.role) };
  if (a === 'settings' && seg.length === 1) return { name: 'settings', query };
  if (a === 'settings' && b === 'advanced' && seg.length === 2) return { name: 'connections', section: 'advanced', query };
  if ((a === 'inbox' || a === 'escalations') && seg.length <= 2) {
    if (b !== undefined && !TICKET_ID.test(b)) return notFound(query);
    return { name: a, ticketId: b === undefined ? undefined : Number(b), query };
  }
  if (a === 'vendor-setup' && seg.length <= 2) return { name: 'vendor-setup', vendorId: b, query };
  if (['team', 'approver', 'ahead', 'styleguide', 'connections'].includes(a) && seg.length === 1) return { name: a, query };
  if (a === 'runs') {
    if (seg.length === 1) return { name: 'runs', query };
    if (b === 'new' && seg.length === 2) return { name: 'run-new', query };
    if (!RUN_ID.test(b)) return notFound(query);
    const isInbox = !!inboxRun && b === inboxRun;
    if (seg.length === 2) return isInbox ? { name: 'inbox', query, redirect: href('inbox') } : { name: 'overview', runId: b, query };
    if (c === 'prevent') {
      if (seg.length !== 3) return notFound(query);
      return isInbox ? { name: 'ahead', query, redirect: href('ahead') } : { name: 'prevent', runId: b, query };
    }
    if (!SCOPES.includes(c) || seg.length > 4) return notFound(query);
    if (seg.length === 4 && !TICKET_ID.test(d)) return notFound(query);
    const route = seg.length === 4 ? { name: c, runId: b, ticketId: Number(d), query } : { name: c, runId: b, query };
    if (!inboxRun) return route;
    return { ...route, redirect: isInbox ? href('inbox', { ticketId: route.ticketId }) : href('advanced') };
  }
  // #/tickets[/:id] and #/review[/:id], from before runs had ids in the address: the inbox now holds every ticket.
  if (SCOPES.includes(a) && seg.length <= 2) {
    if (b !== undefined && !TICKET_ID.test(b)) return notFound(query);
    return { name: 'inbox', query, redirect: href('inbox', { ticketId: b === undefined ? undefined : Number(b) }) };
  }
  return notFound(query);
}

/** Where a run's tickets/review link goes once the inbox run id is known (used by views/tickets.js and views/review.js). */
export function runLinkTarget(route, inboxRunId) {
  if (inboxRunId && route?.runId === inboxRunId) return href('inbox', { ticketId: route.ticketId });
  return href('advanced');
}

// href('inbox', { ticketId, query }) -> '#/inbox/41259'. Empty and default query values are dropped.
export function href(name, { runId, ticketId, vendorId, query } = {}) {
  const qs = queryString(query);
  switch (name) {
    case 'run-new': return `#/runs/new${qs}`;
    case 'overview': return `#/runs/${runId}${qs}`;
    case 'tickets':
    case 'review': return `#/runs/${runId}/${name}${ticketId ? `/${ticketId}` : ''}${qs}`;
    case 'prevent': return `#/runs/${runId}/prevent${qs}`;
    case 'settings': return `#/settings${qs}`;
    case 'inbox':
    case 'escalations': return `#/${name}${ticketId ? `/${ticketId}` : ''}${qs}`;
    case 'vendor-setup': return `#/vendor-setup${vendorId ? `/${vendorId}` : ''}${qs}`;
    case 'advanced': return `#/settings/advanced${qs}`;
    case 'team':
    case 'approver':
    case 'ahead':
    case 'styleguide':
    case 'connections': return `#/${name}${qs}`;
    default: return `#/runs${qs}`;
  }
}

let dispatch = null;
// The shell registers its route function here: replaceState does not fire `hashchange`.
export function onNavigate(fn) { dispatch = fn; }

// navigate(href('inbox', {...}))              pushes a history entry
// navigate(href(...), { replace: true })      replaces the current entry (filters, stepping, redirects)
export function navigate(to, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', to);
    dispatch?.();
  } else {
    location.hash = to;
  }
}

// Breadcrumb trail for the run-era context bar; the last item has href null (current page).
export function crumbs(route, run) {
  const runLabel = run?.label || route.runId || 'Run';
  const runs = { label: 'Runs', href: href('runs') };
  const runCrumb = { label: runLabel, href: href('overview', { runId: route.runId }) };
  switch (route.name) {
    case 'runs': return [{ label: 'Runs', href: null }];
    case 'run-new': return [runs, { label: 'New run', href: null }];
    case 'overview': return [runs, { label: runLabel, href: null }];
    case 'tickets':
    case 'review': {
      const section = route.name === 'tickets' ? 'Tickets' : 'Review';
      // Going up from a ticket keeps the list's filters / tab ("from" only says where the ticket was opened from).
      const { from, ...listQuery } = route.query || {};
      const list = { label: section, href: route.ticketId ? href(route.name, { runId: route.runId, query: listQuery }) : null };
      return route.ticketId ? [runs, runCrumb, list, { label: `#${route.ticketId}`, href: null }] : [runs, runCrumb, list];
    }
    case 'prevent': return [runs, runCrumb, { label: 'Prevent', href: null }];
    case 'settings': return [{ label: 'Settings', href: null }];
    case 'inbox': return route.ticketId ? [{ label: 'Inbox', href: href('inbox') }, { label: `#${route.ticketId}`, href: null }] : [{ label: 'Inbox', href: null }];
    case 'escalations': return route.ticketId ? [{ label: 'Escalations', href: href('escalations') }, { label: `#${route.ticketId}`, href: null }] : [{ label: 'Escalations', href: null }];
    case 'team': return [{ label: 'Team', href: null }];
    case 'approver': return [{ label: 'Waiting on you', href: null }];
    case 'ahead': return [{ label: 'Conductor: Ahead', href: null }];
    case 'vendor-setup': return [{ label: 'Vendor setup', href: null }];
    case 'connections': return route.section === 'advanced'
      ? [{ label: 'Settings', href: href('connections') }, { label: 'Advanced', href: null }] : [{ label: 'Settings', href: null }];
    case 'styleguide': return [{ label: 'Style guide', href: null }];
    default: return [runs, { label: 'Page not found', href: null }];
  }
}

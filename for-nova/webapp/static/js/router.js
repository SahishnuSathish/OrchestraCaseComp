// Hash router: pure parse/href/crumbs, plus navigate() for the two history modes.
// Routes: #/runs, #/runs/new, #/runs/:runId, #/runs/:runId/tickets[/:id], #/runs/:runId/review[/:id], #/settings.
// Nothing here touches the DOM; location/history are only read inside functions, so the module imports in Node.

const RUN_ID = /^[0-9a-f]{8}$/;
const TICKET_ID = /^[1-9][0-9]*$/;
const SCOPES = ['tickets', 'review'];
const FLAG_KEYS = ['flagged', 'priority'];
const DEFAULTS = { sort: 'seq', tab: 'todo', dir: 'asc' };

function lastRunId() {
  try { return globalThis.localStorage?.getItem('ap.run') || null; } catch { return null; }
}

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

// parse('#/runs/ab12cd34/tickets/41259?from=review') -> { name:'tickets', runId:'ab12cd34', ticketId:41259, query:{from:'review'} }
// `redirect` is set for legacy and empty hashes; the shell applies it with replace. opts.lastRunId overrides localStorage.
export function parse(hash, opts = {}) {
  const raw = String(hash || '').replace(/^#/, '');
  const qAt = raw.indexOf('?');
  const path = (qAt < 0 ? raw : raw.slice(0, qAt)).replace(/^\/+/, '').replace(/\/+$/, '');
  const query = parseQuery(qAt < 0 ? '' : raw.slice(qAt + 1));
  const seg = path ? path.split('/') : [];
  const [a, b, c, d] = seg;

  if (!seg.length || (a === 'run' && seg.length === 1)) return { name: 'runs', query, redirect: '#/runs' };
  if (a === 'settings' && seg.length === 1) return { name: 'settings', query };
  if (a === 'runs') {
    if (seg.length === 1) return { name: 'runs', query };
    if (b === 'new' && seg.length === 2) return { name: 'run-new', query };
    if (!RUN_ID.test(b)) return notFound(query);
    if (seg.length === 2) return { name: 'overview', runId: b, query };
    if (!SCOPES.includes(c) || seg.length > 4) return notFound(query);
    if (seg.length === 3) return { name: c, runId: b, query };
    if (!TICKET_ID.test(d)) return notFound(query);
    return { name: c, runId: b, ticketId: Number(d), query };
  }
  if (SCOPES.includes(a) && seg.length <= 2) {
    if (b !== undefined && !TICKET_ID.test(b)) return notFound(query);
    const runId = opts.lastRunId !== undefined ? opts.lastRunId : lastRunId();
    const target = runId && RUN_ID.test(runId)
      ? href(a, { runId, ticketId: b === undefined ? undefined : Number(b), query })
      : '#/runs';
    return { name: runId && RUN_ID.test(runId) ? a : 'runs', query, redirect: target };
  }
  return notFound(query);
}

// href('tickets', { runId, ticketId, query }) -> '#/runs/ab12cd34/tickets/41259?from=review'. Empty and default query values are dropped.
export function href(name, { runId, ticketId, query } = {}) {
  const qs = queryString(query);
  switch (name) {
    case 'run-new': return `#/runs/new${qs}`;
    case 'overview': return `#/runs/${runId}${qs}`;
    case 'tickets':
    case 'review': return `#/runs/${runId}/${name}${ticketId ? `/${ticketId}` : ''}${qs}`;
    case 'settings': return `#/settings${qs}`;
    default: return `#/runs${qs}`;
  }
}

let dispatch = null;
// The shell registers its route function here: replaceState does not fire `hashchange`.
export function onNavigate(fn) { dispatch = fn; }

// navigate(href('tickets', {...}))            pushes a history entry
// navigate(href(...), { replace: true })      replaces the current entry (filters, stepping, redirects)
export function navigate(to, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', to);
    dispatch?.();
  } else {
    location.hash = to;
  }
}

// Breadcrumb trail for the topbar; the last item has href null (current page).
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
    case 'settings': return [{ label: 'Settings', href: null }];
    default: return [runs, { label: 'Page not found', href: null }];
  }
}

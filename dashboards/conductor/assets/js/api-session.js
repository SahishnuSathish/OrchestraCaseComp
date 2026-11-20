// Sign-in and session calls (docs/phase3/CONTRACTS.md sections 2 and 12). Plain async functions, no DOM.
// Every call that creates a session stores it for this tab with http.session.set(...).
import * as http from './http.js';

const HOMES = {
  ap_specialist: '/app#/inbox',
  cfo: '/app#/escalations',
  approver: '/app#/approver',
  vendor: '/direct',
};

// A sign-in that fails is an answer, not a signed-out tab, so these calls never redirect on 401.
const quiet = { redirectOn401: false };

function keep(answer) {
  http.session.set(answer);
  return answer;
}

export function homeFor(role) {
  return HOMES[role] || '/';
}

export function directory() {
  return http.getJSON('/api/session/directory', quiet);
}

export async function ssoStaff(email) {
  return keep(await http.postJSON('/api/session/sso', { kind: 'staff', email }, quiet));
}

export async function ssoVendor(provider, email) {
  return keep(await http.postJSON('/api/session/sso', { kind: 'vendor', provider, email }, quiet));
}

export function requestCode(email, invoice) {
  return http.postJSON('/api/session/code/request', { email, invoice }, quiet);
}

export async function verifyCode(email, invoice, code) {
  return keep(await http.postJSON('/api/session/code/verify', { email, invoice, code }, quiet));
}

// The signed-in session, or null when signed out. Never redirects.
export async function current() {
  if (!http.session.get()) return null;
  try {
    return keep(await http.getJSON('/api/session', quiet));
  } catch (e) {
    if (e && e.status === 401) {
      http.session.clear();
      return null;
    }
    throw e;
  }
}

export async function signOut() {
  try {
    await http.del('/api/session', quiet);
  } catch { /* the server may already have forgotten it */ }
  http.session.clear();
  try { // this person's open ticket tabs (components/workspace/tabs-store.js) leave with them
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('conductor.ticketTabs')) sessionStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
  location.assign('/');
}

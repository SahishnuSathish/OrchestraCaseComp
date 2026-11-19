// The one door between the sign-in screens (and the staff shell) and the session API (CONTRACTS.md section 2).
// Each function uses the real api-session.js export when it exists. Until identity-live merges, the stub exports
// nothing, so each falls back to the isolated local stand-in in ./session-fake.js.
// MERGE NOTE (orchestrator): once api-session.js exports every function below, delete ./session-fake.js and the
// `fake` import and fallbacks here; the exported names and shapes stay the same.
import * as real from '../api-session.js';
import * as http from '../http.js';
import * as fake from './session-fake.js';

const pick = (name) => (typeof real[name] === 'function' ? real[name] : fake[name]);

/** True while the local stand-in answers (before identity-live merges). */
export const usingStandIn = typeof real.ssoStaff !== 'function';

/** { accounts: [{ email, name, title, department, role }] } - staff and approver sign-ins only. */
export const directory = (...a) => pick('directory')(...a);
/** { session, role, name, email, title, home }; rejects with status 401 and a neutral message. */
export const ssoStaff = (...a) => pick('ssoStaff')(...a);
/** provider: 'microsoft' | 'google'. Same answer plus vendor: { id, name }; the same neutral 401 for every failure. */
export const ssoVendor = (...a) => pick('ssoVendor')(...a);
/** { ok, message, inbox: { to, subject, code } | null } */
export const requestCode = (...a) => pick('requestCode')(...a);
/** The vendor session answer, or a 401 "That code is not valid or has expired." */
export const verifyCode = (...a) => pick('verifyCode')(...a);
/** The current session answer, or null when signed out. Never redirects. */
export const current = (...a) => pick('current')(...a);
/** Clears the session, then returns to the sign-in hub. */
export const signOut = (...a) => pick('signOut')(...a);

/** Forget this tab's session locally without leaving the page (used when a person backs out of the vendor picker). */
export function forgetLocal() { http.session.clear(); }

/** homeFor(role) -> '/app#/inbox' | '/app#/escalations' | '/app#/approver' | '/direct' */
export function homeFor(role) {
  if (typeof real.homeFor === 'function') return real.homeFor(role);
  return fake.homeFor(role);
}

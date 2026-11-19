// The one door between the sign-in screens (and the staff shell) and the session API (CONTRACTS.md section 2).
// It re-exports api-session.js, plus one local helper. (The pre-merge local stand-in was removed at the merge.)
import * as http from '../http.js';

export { directory, ssoStaff, ssoVendor, requestCode, verifyCode, current, signOut, homeFor } from '../api-session.js';

/** Always false now: the real session API answers. Kept so older imports keep working. */
export const usingStandIn = false;

/** Forget this tab's session locally without leaving the page (used when a person backs out of the vendor picker). */
export function forgetLocal() { http.session.clear(); }

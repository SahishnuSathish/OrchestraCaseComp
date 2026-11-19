// LOCAL STAND-IN for the session API, used only until p3/identity-live merges api-session.js.
// The orchestrator deletes this file at merge (see session-port.js). It mirrors CONTRACTS.md section 2 exactly:
// same function names, same answer shapes, same neutral failures. People and vendors are copied from data/.
// It never calls the server; the "session" is a local token so the pages can be exercised end to end.
import { session, HttpError } from '../http.js';

const HOMES = { ap_specialist: '/app#/inbox', cfo: '/app#/escalations', approver: '/app#/approver', vendor: '/direct' };
export const homeFor = (role) => HOMES[role] || '/';

const DOMAIN = 'orchestra-mock.example';
const person = (first, last, title, department, role) => ({
  email: `${first}.${last}@${DOMAIN}`.toLowerCase(), name: `${first} ${last}`, title, department, role,
});
// employees.csv: the AP team (Zendesk agents) and every approver with a pending bill (or the active delegate).
const ACCOUNTS = [
  person('Elena', 'Lockhart', 'Chief Financial Officer', 'Finance', 'cfo'),
  person('Ulla', 'Abernathy', 'Accounts Payable Specialist', 'Finance', 'ap_specialist'),
  person('Omar', 'Calloway', 'Accounts Payable Specialist', 'Finance', 'ap_specialist'),
  person('Ana', 'Jessup', 'Research Director', 'Client Services', 'approver'),
  person('Ana', 'Underhill', 'Strategy Lead', 'Client Services', 'approver'),
  person('Ben', 'Merriweather', 'Senior Account Executive', 'Client Services', 'approver'),
  person('Elena', 'Fairbanks', 'Research Director', 'Client Services', 'approver'),
  person('Ines', 'Brightwater', 'Office Manager', 'Client Services', 'approver'),
  person('Liam', 'Pemberton', 'Senior Account Executive', 'Client Services', 'approver'),
  person('Quinn', 'Winslow', 'Research Director', 'Client Services', 'approver'),
  person('Rosa', 'Dunmore', 'Account Director', 'Client Services', 'approver'),
  person('Victor', 'Yarborough', 'Creative Director', 'Client Services', 'approver'),
  person('Yara', 'Merriweather', 'Strategy Lead', 'Client Services', 'approver'),
];
// vendors.csv authorizedContacts and vendor_bills.csv invoice numbers, for a few vendors.
const VENDORS = [
  { id: '3000', name: 'Quillfern Studio', contacts: ['billing@quillfernstudio.example', 'finance@quillfernstudio.example', 'ulla@quillfernstudio.example'], invoices: ['INV-11534', 'INV-54746', 'INV-72760'] },
  { id: '3001', name: 'Bramblewick Print Co', contacts: ['accounts@bramblewickprintco.example', 'ar@bramblewickprintco.example', 'ben@bramblewickprintco.example'], invoices: ['24985', '28953', '39236'] },
];
const NEUTRAL = "We couldn't sign you in with that account.";
const BAD_CODE = 'That code is not valid or has expired.';
const CODES_KEY = 'conductor.standin.codes';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').trim().toLowerCase();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
const vendorFor = (email) => {
  const hits = VENDORS.filter((v) => v.contacts.includes(norm(email)));
  return hits.length === 1 ? hits[0] : null;
};
const contactName = (email) => {
  const local = norm(email).split('@')[0];
  if (['billing', 'finance', 'accounts', 'ar'].includes(local)) return { billing: 'Billing team', finance: 'Finance team', accounts: 'Accounts team', ar: 'Receivables team' }[local];
  return local.charAt(0).toUpperCase() + local.slice(1);
};
function start(answer) {
  const stored = { ...answer, session: `local-${token()}` };
  session.set(stored);
  return stored;
}
function vendorAnswer(email, v) {
  return start({ role: 'vendor', name: contactName(email), email: norm(email), title: null, home: homeFor('vendor'), vendor: { id: v.id, name: v.name } });
}

export async function directory() {
  await wait(220);
  return { accounts: ACCOUNTS.map((a) => ({ ...a })) };
}

export async function ssoStaff(email) {
  await wait(260);
  const a = ACCOUNTS.find((x) => x.email === norm(email));
  if (!a) throw new HttpError(401, NEUTRAL, NEUTRAL);
  return start({ role: a.role, name: a.name, email: a.email, title: a.title, home: homeFor(a.role) });
}

export async function ssoVendor(provider, email) {
  await wait(650);
  void provider;
  const v = vendorFor(email);
  if (!v) throw new HttpError(401, NEUTRAL, NEUTRAL);
  return vendorAnswer(email, v);
}

function readCodes() { try { return JSON.parse(sessionStorage.getItem(CODES_KEY) || '{}'); } catch { return {}; } }
function writeCodes(c) { try { sessionStorage.setItem(CODES_KEY, JSON.stringify(c)); } catch { /* storage blocked */ } }

export async function requestCode(email, invoice) {
  await wait(420);
  const message = 'If that email and invoice match our records, a sign-in code is on its way. It expires in 10 minutes.';
  const v = vendorFor(email);
  const inv = String(invoice || '').trim().toUpperCase();
  if (!v || !v.invoices.map((x) => x.toUpperCase()).includes(inv)) return { ok: true, message, inbox: null };
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const codes = readCodes();
  codes[`${norm(email)}|${inv}`] = { code, at: Date.now() };
  writeCodes(codes);
  return { ok: true, message, inbox: { to: norm(email), subject: 'Your Orchestra sign-in code', code } };
}

export async function verifyCode(email, invoice, code) {
  await wait(380);
  const key = `${norm(email)}|${String(invoice || '').trim().toUpperCase()}`;
  const codes = readCodes();
  const hit = codes[key];
  const v = vendorFor(email);
  if (!v || !hit || hit.code !== String(code || '').trim() || Date.now() - hit.at > 10 * 60 * 1000) throw new HttpError(401, BAD_CODE, BAD_CODE);
  delete codes[key];
  writeCodes(codes);
  return vendorAnswer(email, v);
}

export async function current() {
  const s = session.get();
  return s && s.session ? s : null;
}

export async function signOut() {
  session.clear();
  location.assign('/');
}

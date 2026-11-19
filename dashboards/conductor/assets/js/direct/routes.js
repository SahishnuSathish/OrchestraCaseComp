// Hash routes inside /direct. Pure functions, no DOM, so back, forward and reload all land on the same view.
//   #/invoices[?q=&status=]   #/invoices/<ref>   #/messages   #/documents   #/updates

export const SECTIONS = ['invoices', 'messages', 'documents', 'updates'];

export function parse(hash = '') {
  const raw = String(hash).replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  const query = Object.fromEntries(new URLSearchParams(qs));
  const section = SECTIONS.includes(parts[0]) ? parts[0] : 'invoices';
  const ref = section === 'invoices' && parts[1] ? parts[1] : null;
  return { section, ref, query, known: !parts[0] || SECTIONS.includes(parts[0]) };
}

export function format({ section = 'invoices', ref = null, query = {} } = {}) {
  let out = `#/${section}`;
  if (ref) out += `/${encodeURIComponent(ref)}`;
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString();
  return qs ? `${out}?${qs}` : out;
}

export const invoiceHref = (ref) => format({ section: 'invoices', ref });

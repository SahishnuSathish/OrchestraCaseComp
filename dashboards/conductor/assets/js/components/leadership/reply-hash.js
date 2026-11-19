// The fingerprint of a reply exactly as it would go out: SHA-256 over [recipient, subject, body].
// It matches delivery.reply_hash() on the server, which hashes json.dumps([to, subject, body], ensure_ascii=True).
// The CFO signs off on the text she is reading; the server refuses the sign-off if the stored reply differs.

// Python's json string encoding with ensure_ascii: \" \\ \b \f \n \r \t, every other character outside
// space..tilde as \uXXXX (lowercase hex). JavaScript strings are UTF-16, so astral characters become the same
// surrogate pairs Python writes.
function pyString(s) {
  if (s == null) return 'null';
  const str = String(s);
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += str[i];
  }
  return `${out}"`;
}

/** replyHash(to, subject, body) -> Promise<hex string> */
export async function replyHash(to, subject, body) {
  const text = `[${pyString(to)}, ${pyString(subject)}, ${pyString(body)}]`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

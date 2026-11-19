// W-9 data access (docs/phase3/CONTRACTS.md sections 9 and 10). Plain async functions, no DOM.
// Every call goes through http.js. A TIN never reaches the browser beyond its last 4 digits.
import * as http from './http.js';

const enc = encodeURIComponent;
const HEX = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- vendor side (Conductor: Direct)
export const status = () => http.getJSON('/api/direct/w9');

export const startUpload = ({ filename, size, mime }) => http.postJSON('/api/direct/w9/uploads', { filename, size, mime });

export const putChunk = (uploadId, n, bytes) => http.request('PUT', `/api/direct/w9/uploads/${enc(uploadId)}/chunks/${n}`, bytes);

export const completeUpload = (uploadId, sha256) => http.postJSON(`/api/direct/w9/uploads/${enc(uploadId)}/complete`, { sha256 });

export async function sha256Hex(blob) {
  return HEX(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

// Upload one PDF in chunks. onProgress(fraction 0..1) is called as parts land. Resolves with the server's answer.
export async function uploadFile(file, { onProgress, signal } = {}) {
  const { upload_id: id, chunk_size: size } = await startUpload({ filename: file.name, size: file.size, mime: file.type });
  const total = Math.max(1, Math.ceil(file.size / size));
  for (let n = 0; n < total; n++) {
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    await http.request('PUT', `/api/direct/w9/uploads/${enc(id)}/chunks/${n}`, file.slice(n * size, (n + 1) * size), { signal });
    onProgress?.((n + 1) / total);
  }
  return completeUpload(id, await sha256Hex(file));
}

// ---- staff side (Conductor: vendor setup)
export const queue = () => http.getJSON('/api/w9/queue');
export const vendor = (vendorId) => http.getJSON(`/api/w9/${enc(vendorId)}`);
export const requestW9 = (vendorId) => http.postJSON(`/api/w9/${enc(vendorId)}/request`, {});
export const upload = (uploadId) => http.getJSON(`/api/w9/uploads/${enc(uploadId)}`);
export const verify = (uploadId) => http.postJSON(`/api/w9/uploads/${enc(uploadId)}/verify`, {});

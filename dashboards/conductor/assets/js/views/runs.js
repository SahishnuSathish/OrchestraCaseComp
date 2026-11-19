// Retired: batch runs, the tickets-file import and the results export moved to Settings, Advanced
// (connections.js, CFO only). Kept as a module because app.js still imports it; old links render Advanced.
import { mount as mountSettings } from './connections.js';

export function mount(root, ctx = {}) {
  return mountSettings(root, { ...ctx, route: { name: 'connections', section: 'advanced', query: {} } });
}

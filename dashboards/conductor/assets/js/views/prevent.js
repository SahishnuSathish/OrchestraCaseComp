// Retired: the run-era Prevent page became Conductor: Ahead (ahead.js), which works on the inbox run.
// Kept as a module because app.js still imports it; old links render Ahead.
import { mount as mountAhead } from './ahead.js';

export function mount(root, ctx = {}) {
  return mountAhead(root, { ...ctx, route: { name: 'ahead', query: {} } });
}

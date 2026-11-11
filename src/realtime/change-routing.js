/** Pure helper: route panel changes to the correct activation when the URL supplies one. */
const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
export function classifyDeviceChange(path, method) {
  if (!['POST','PUT','PATCH','DELETE'].includes(method)) return null;
  const parts = String(path || '').split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'v1') return null;
  const root = parts[2];
  if (!['admin','partner','content-partner'].includes(root)) return null;
  const area = parts[3];
  const allowed = new Set(['devices','activations','licenses','partners','providers','provider-monitor','codes','config','settings','platform-settings']);
  if (!allowed.has(area)) return null;
  let activationId = null;
  // /admin/devices/activations/:uuid/action, /partner/devices/:uuid/action
  if (area === 'devices' && root === 'admin' && parts[4] === 'activations' && uuid.test(parts[5] || '')) activationId = parts[5];
  else if (area === 'activations' && uuid.test(parts[4] || '')) activationId = parts[4];
  else if (area === 'devices' && root !== 'admin' && uuid.test(parts[4] || '')) activationId = parts[4];
  // Lists attached to the same MAC may be updated separately; global changes are still broadcast.
  const action = parts.at(-1) || '';
  const critical = ['block','revoke','suspend','remove-list','deactivate','disconnect'].includes(action) || method === 'DELETE';
  return { topic: critical ? 'session' : area === 'devices' ? 'devices' : area,
    activationId, priority: activationId ? 'targeted' : 'global' };
}

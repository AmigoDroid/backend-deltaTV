// Contadores do namespace de rede Linux visível ao processo. Não executa comandos
// nem lê conexões, URLs, IPs ou credenciais dos espectadores.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

export function parseNetworkCounters(text) {
  const result = new Map();
  for (const line of String(text).split('\n')) {
    const colon = line.lastIndexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (!name || fields.length < 16 || fields.some(n => !Number.isSafeInteger(n) || n < 0)) continue;
    result.set(name, { name, receivedBytes: fields[0], sentBytes: fields[8],
      receiveErrors: fields[2], receiveDrops: fields[3], sendErrors: fields[10], sendDrops: fields[11] });
  }
  return result;
}

export function defaultRouteInterfaces(ipv4 = '', ipv6 = '') {
  const names = new Set();
  for (const line of String(ipv4).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 8 && f[1] === '00000000' && f[7] === '00000000' && (parseInt(f[3], 16) & 1)) names.add(f[0]);
  }
  for (const line of String(ipv6).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 10 && /^0{32}$/.test(f[0]) && f[1] === '00' && (parseInt(f[8], 16) & 1)) names.add(f[9]);
  }
  names.delete('lo');
  return [...names];
}

const fallbackInterface = name => name !== 'lo' && !/^(?:veth|docker|br-|virbr|tun\d|tap\d|wg\d)/.test(name);
const optionalFile = (read, file) => { try { return read(file, 'utf8'); } catch { return ''; } };
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

export function createNetworkSampler({ readFile = fs.readFileSync, now = () => performance.now(),
  configuredInterfaces = () => process.env.VPS_NETWORK_INTERFACES || '',
  capacityMbps = () => process.env.VPS_NETWORK_CAPACITY_MBPS } = {}) {
  let previous = null;
  return function sample() {
    let counters;
    try { counters = parseNetworkCounters(readFile('/proc/net/dev', 'utf8')); }
    catch { previous = null; return { available: false, reason: 'Contadores de rede indisponíveis neste ambiente.' }; }
    const at = now();
    const elapsed = previous ? (at - previous.at) / 1000 : null;
    // Após inatividade da tela, coleta uma nova referência em vez de chamar a
    // média de vários minutos de velocidade atual.
    const measurable = elapsed != null && elapsed > 0 && elapsed <= 30;
    const configured = [...new Set(String(configuredInterfaces()).split(',').map(v => v.trim()).filter(Boolean))];
    const routes = defaultRouteInterfaces(optionalFile(readFile, '/proc/net/route'), optionalFile(readFile, '/proc/net/ipv6_route'));
    const routeNames = routes.filter(name => counters.has(name));
    const selection = configured.length ? 'configured' : routeNames.length ? 'default-route' : 'automatic';
    const selectedNames = configured.length ? configured : routeNames.length ? routeNames : [...counters.keys()].filter(fallbackInterface);
    const selected = new Set(selectedNames);
    const interfaces = [...counters.values()].sort((a, b) => a.name.localeCompare(b.name)).map(row => {
      const before = previous?.counters.get(row.name);
      const reset = !!before && (row.receivedBytes < before.receivedBytes || row.sentBytes < before.sentBytes);
      const valid = measurable && !!before && !reset;
      return { ...row, included: selected.has(row.name), counterReset: reset,
        receiveBytesPerSecond: valid ? (row.receivedBytes - before.receivedBytes) / elapsed : null,
        sendBytesPerSecond: valid ? (row.sentBytes - before.sentBytes) / elapsed : null };
    });
    previous = { at, counters };
    const rows = interfaces.filter(row => row.included);
    const missingInterfaces = selectedNames.filter(name => !counters.has(name));
    const validTotals = rows.length > 0 && !missingInterfaces.length && rows.every(row => row.receiveBytesPerSecond != null && row.sendBytesPerSecond != null);
    const capacity = Number(capacityMbps());
    return { available: rows.length > 0 && !missingInterfaces.length, selection, selectedInterfaces: rows.map(row => row.name), missingInterfaces,
      reason: missingInterfaces.length ? 'Uma interface configurada não está disponível.' : !rows.length ? 'Nenhuma interface externa detectada.' : null,
      intervalSeconds: measurable ? elapsed : null,
      capacityMbps: Number.isFinite(capacity) && capacity > 0 ? capacity : null,
      receivedBytes: sum(rows, 'receivedBytes'), sentBytes: sum(rows, 'sentBytes'),
      receiveBytesPerSecond: validTotals ? sum(rows, 'receiveBytesPerSecond') : null,
      sendBytesPerSecond: validTotals ? sum(rows, 'sendBytesPerSecond') : null,
      receiveErrors: sum(rows, 'receiveErrors'), sendErrors: sum(rows, 'sendErrors'),
      receiveDrops: sum(rows, 'receiveDrops'), sendDrops: sum(rows, 'sendDrops'), interfaces };
  };
}

export const readNetworkMetrics = createNetworkSampler();

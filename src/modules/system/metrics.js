// Telemetria leve do próprio host Linux. Nada de spawn/exec, banco ou serviços externos.
// Cache compartilhado para HTTP e WebSocket, reduzindo leituras do /proc e do sistema de arquivos.
import os from "node:os";
import fs from "node:fs";
import { readNetworkMetrics } from "./network.js";
import { relayStats } from "../../shared/relay.js";
import { env } from "../../config/env.js";

// CPU, RAM e tráfego: até 2 amostras por segundo; disco: uma leitura a cada 1 s.
const MIN_SAMPLE_MS = 350;
const STORAGE_SAMPLE_MS = 1000;
let lastStorage = null;
let lastSample = null;
let previousCpu = null;

export function cpuCounters(cpus) {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

export function cpuPercent(before, after) {
  if (!before) return null;
  const delta = after.total - before.total;
  if (delta <= 0) return null;
  const busy = delta - (after.idle - before.idle);
  return Math.round(Math.max(0, Math.min(100, (100 * busy) / delta)) * 10) / 10;
}

function linuxMemory() {
  try {
    const info = {};
    for (const line of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const match = /^([A-Za-z_]+):\s+(\d+) kB$/.exec(line);
      if (match) info[match[1]] = Number(match[2]) * 1024;
    }
    const total = info.MemTotal || os.totalmem();
    // MemAvailable inclui cache recuperável, ao contrário de MemFree.
    const available = info.MemAvailable ?? os.freemem();
    const swapTotal = info.SwapTotal ?? 0;
    const swapFree = info.SwapFree ?? 0;
    return {
      memory: { total, available, used: Math.max(0, total - available) },
      swap: { total: swapTotal, used: Math.max(0, swapTotal - swapFree) },
    };
  } catch {
    const total = os.totalmem();
    const available = os.freemem();
    return { memory: { total, available, used: Math.max(0, total - available) }, swap: null };
  }
}

function rootStorage() {
  const now = Date.now();
  if (lastStorage && now - lastStorage.at < STORAGE_SAMPLE_MS) return lastStorage.value;
  try {
    const stat = fs.statfsSync("/", { bigint: true });
    const total = Number(stat.blocks * stat.bsize);
    const available = Number(stat.bavail * stat.bsize);
    const free = Number(stat.bfree * stat.bsize);
    // Inclui espaço reservado pelo filesystem no total ocupado.
    const value = { total, used: Math.max(0, total - free), available };
    lastStorage = { at: now, value };
    return value;
  } catch {
    return lastStorage?.value ?? null;
  }
}

export function readHostMetrics() {
  const now = Date.now();
  if (lastSample && now - lastSample.at < MIN_SAMPLE_MS) return lastSample.value;

  const coreTimes = os.cpus();
  const cpu = cpuCounters(coreTimes);
  const usedPercent = cpuPercent(previousCpu, cpu);
  previousCpu = cpu;
  const memory = linuxMemory();
  const runtime = process.memoryUsage();
  const value = {
    sampledAt: new Date(now).toISOString(),
    cpu: { percent: usedPercent, cores: coreTimes.length, load1: Math.round(os.loadavg()[0] * 100) / 100 },
    ...memory,
    storage: rootStorage(),
    network: readNetworkMetrics(),
    transmission: { nodeActiveStreams: relayStats().activeStreams, nodeStreamLimit: env.proxyMaxConcurrent, nginxAccelEnabled: env.nginxMediaProxy || env.accelOrigin, mediaProxyEngine: env.nginxMediaProxy ? "nginx" : "node" },
    uptimeSeconds: Math.floor(os.uptime()),
    node: { rss: runtime.rss, heapUsed: runtime.heapUsed, heapTotal: runtime.heapTotal, uptimeSeconds: Math.floor(process.uptime()) },
  };
  lastSample = { at: now, value };
  return value;
}

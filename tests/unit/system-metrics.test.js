import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuCounters, cpuPercent, readHostMetrics } from "../../src/modules/system/metrics.js";

test("CPU usage is derived from the difference between two snapshots", () => {
  const fake = (user, idle) => [{ times: { user, nice: 0, sys: 0, irq: 0, idle } }];
  const before = cpuCounters(fake(200, 800));
  const after = cpuCounters(fake(260, 840));
  assert.equal(cpuPercent(before, after), 60);
  assert.equal(cpuPercent(null, after), null);
  assert.equal(cpuPercent(after, after), null);
});

test("System metrics sample has bounded numeric fields and no secrets", () => {
  const m = readHostMetrics();
  assert.ok(m.sampledAt);
  assert.ok(m.cpu.cores >= 1);
  assert.ok(m.memory.total > 0);
  assert.ok(m.memory.available >= 0);
  assert.ok(m.node.rss > 0);
  assert.ok(m.storage === null || m.storage.total > 0);
  assert.equal(Object.hasOwn(m, "env"), false);
  assert.equal(Object.hasOwn(m, "processes"), false);
});

test("Frequent reads are cached for at least one second", () => {
  const a = readHostMetrics();
  const b = readHostMetrics();
  assert.strictEqual(a, b);
});

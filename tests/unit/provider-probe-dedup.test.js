import test from "node:test";
import assert from "node:assert/strict";
import { createSharedProbe, probeTargetKey, isNewProbeSample } from "../../src/modules/provider-monitor/probe-dedup.js";

test("URLs equivalentes têm a mesma chave; protocolo e porta diferente não", () => {
  assert.equal(probeTargetKey("HTTP://ExEmPlo.com:80/"), probeTargetKey("http://exemplo.com"));
  assert.equal(probeTargetKey("https://Exemplo.com:443/qualquer/caminho"), probeTargetKey("https://exemplo.com"));
  assert.notEqual(probeTargetKey("http://exemplo.com"), probeTargetKey("https://exemplo.com"));
  assert.notEqual(probeTargetKey("http://exemplo.com:8080"), probeTargetKey("http://exemplo.com"));
  assert.notEqual(probeTargetKey("http://exemplo.com"), probeTargetKey("http://outro.com"));
});

test("cem cadastros compartilhando a URL fazem somente uma sondagem", async () => {
  let requests = 0;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const shared = createSharedProbe(async () => {
    requests++;
    await gate;
    return { good: true, latencyMs: 85, error: null };
  });
  const jobs = Array.from({ length: 100 }, (_, n) => shared(n % 2 ? "http://exemplo.com" : "HTTP://EXEMPLO.COM:80/"));
  finish();
  const results = await Promise.all(jobs);
  assert.equal(requests, 1);
  assert.equal(new Set(results.map(r => r.sampledAt.getTime())).size, 1);
  assert.deepEqual(results[0].good, true);
  assert.equal(shared.stats().requests, 1);
  assert.equal(shared.stats().joined, 99);
});

test("cache reaproveita falha sem acelerar a contagem de incidentes", async () => {
  let clock = 10_000, requests = 0;
  const shared = createSharedProbe(async () => {
    requests++;
    return { good: false, latencyMs: 3050, error: "Timeout" };
  }, { now: () => clock, ttlMs: 60_000 });
  const first = await shared("http://exemplo.com");
  clock += 10_000;
  const second = await shared("http://exemplo.com");
  assert.equal(requests, 1);
  assert.equal(first.sampledAt.getTime(), second.sampledAt.getTime());
  assert.equal(isNewProbeSample(first.sampledAt, second.sampledAt), false);
  clock += 60_000;
  const third = await shared("http://exemplo.com");
  assert.equal(requests, 2);
  assert.equal(isNewProbeSample(first.sampledAt, third.sampledAt), true);
});

test("destinos diferentes continuam independentes; LRU respeita o limite", async () => {
  let requests = 0;
  const shared = createSharedProbe(async () => ({ good: true, latencyMs: ++requests }), { maxEntries: 2 });
  await shared("https://a.example");
  await shared("https://b.example");
  await shared("https://a.example");
  await shared("https://c.example");
  assert.equal(shared.stats().cached, 2);
  assert.equal(shared.stats().evictions, 1);
  await shared("https://b.example");
  assert.equal(requests, 4);
});

test("falha inesperada na sondagem não fica presa no cache ou no controle de execução", async () => {
  let attempts = 0;
  const shared = createSharedProbe(async () => {
    if (++attempts === 1) throw new Error("falhou");
    return { good: true, latencyMs: 50 };
  });
  await assert.rejects(shared("http://exemplo.com"), /falhou/);
  const ok = await shared("http://exemplo.com");
  assert.equal(ok.good, true);
  assert.equal(attempts, 2);
  assert.equal(shared.stats().inFlight, 0);
});

test("medição não confunde URL malformada com URL válida", () => {
  assert.notEqual(probeTargetKey("servidor-exemplo"), probeTargetKey("http://servidor-exemplo"));
});

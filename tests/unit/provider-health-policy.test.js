import test from "node:test";
import assert from "node:assert/strict";
import { healthTransition } from "../../src/modules/provider-monitor/health-policy.js";
import { xtreamApiUrl } from "../../src/modules/provider-monitor/url-utils.js";

test("resposta HTTP lenta NÃO conta como queda", () => {
  const first = healthTransition({failures:0,successes:0}, {good:true,slow:true,latencyMs:3050});
  const second = healthTransition(first, {good:true,slow:true,latencyMs:3050});
  assert.equal(second.state, "slow");
  assert.equal(second.failures, 0);
});
test("duas falhas reais seguidas contam como down", () => {
  const first = healthTransition({failures:0,successes:0}, {good:false,slow:false});
  const second = healthTransition(first, {good:false,slow:false});
  assert.equal(first.state,"suspect"); assert.equal(second.state,"down");
});
test("recuperação de indisponibilidade distingue slow e healthy", () => {
  let current = healthTransition({failures:2,successes:0}, {good:true,slow:true});
  current = healthTransition(current, {good:true,slow:false});
  assert.equal(current.state, "healthy");
});
test("URL Xtream conserva subdiretório mas remove query e fragmento", () => {
  assert.equal(xtreamApiUrl("https://exemplo.test/portal/?q=1#frag").href, "https://exemplo.test/portal/player_api.php");
  assert.equal(xtreamApiUrl("https://exemplo.test").href, "https://exemplo.test/player_api.php");
});

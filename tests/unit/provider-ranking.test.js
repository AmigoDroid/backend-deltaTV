import test from "node:test";
import assert from "node:assert/strict";
import { selectHealthy } from "../../src/modules/provider-monitor/ranking.js";
const a={id:"a",latencyMs:130},b={id:"b",latencyMs:75};
test("prefere o mais rápido sem pin",()=>assert.equal(selectHealthy([b,a],null,100)?.id,"b"));
test("mantém a URL durante a janela de estabilidade",()=>assert.equal(selectHealthy([b,a],{providerId:"a",until:200},100)?.id,"a"));
test("troca após janela expirar se houver ganho significativo",()=>assert.equal(selectHealthy([b,a],{providerId:"a",until:90},100)?.id,"b"));
test("não alterna por diferença pequena",()=>assert.equal(selectHealthy([{id:"b",latencyMs:95},{id:"a",latencyMs:100}],{providerId:"a",until:90},100)?.id,"a"));
test("troca imediatamente quando servidor pinado não está saudável",()=>assert.equal(selectHealthy([b],{providerId:"a",until:500},100)?.id,"b"));

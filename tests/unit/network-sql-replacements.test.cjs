"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../src/modules");
const files = [
  "distribution/network.service.js",
  "service-plans/plan.service.js",
];
test("PostgreSQL named replacements must not touch comparison operators", () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const malformed = /(?:<=|>=|<>|!=|[<>])(:[A-Za-z_][A-Za-z0-9_]*)/g;
    const hits = [...source.matchAll(malformed)].map(match => match[0]);
    assert.deepEqual(hits, [], `${file}: suspected unexpanded SQL replacement(s): ${hits.join(", ")}`);
  }
});
test("the Masters' recursive queries retain their named bound parameters", () => {
  const source = fs.readFileSync(path.join(root,"distribution/network.service.js"),"utf8");
  for (const fragment of [
    "a.hops < :limit", "s.depth < :maxdepth",
    "t.depth < :limit", "m.depth < :maxdepth",
  ]) {
    assert.ok(source.includes(fragment), `missing SQL parameter separator: ${fragment}`);
  }
});

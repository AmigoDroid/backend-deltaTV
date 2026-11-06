"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.resolve(__dirname, "../../src/modules/white-label/white-label.routes.js");
const routes = fs.readFileSync(file, "utf8");
const service = fs.readFileSync(path.resolve(__dirname, "../../src/modules/white-label/white-label.service.js"), "utf8");

test("Zod 4: .omit deriva de objeto sem refinamentos antes de superRefine", () => {
  assert.match(routes, /const appBaseBody\s*=\s*z\.object\(/);
  assert.match(routes, /const createBody\s*=\s*appBaseBody\.superRefine\(/);
  assert.match(routes, /const updateBody\s*=\s*partialInput\(appBaseBody\.omit\(\{ partnerId: true, appKey: true \}\)\)\.strict\(\)/);
  assert.doesNotMatch(routes, /createBody\.omit\(/);
});

test("PATCH: não inclui defaults de criação em campos omitidos", () => {
  assert.match(routes, /import\s*\{\s*validate,\s*partialInput\s*\}/);
  assert.match(routes, /const serverUpdate\s*=\s*partialInput\(serverBody\)\.strict\(\)/);
  assert.match(routes, /status: z\.enum\(\["draft", "active", "suspended"\]\)\.default\("draft"\)/);
  assert.match(routes, /priority: z\.number\(\)\.int\(\)\.min\(-1000\)\.max\(1000\)\.default\(0\)/);
});

test("regra de limite do plano permanece validada para criação e atualização", () => {
  assert.match(routes, /value\.planType === "limited" && !value\.activationLimit/);
  assert.match(service, /nextType === "limited" && \(!Number\.isInteger\(nextLimit\) \|\| nextLimit < 1\)/);
  assert.match(service, /LIMIT_BELOW_USAGE/);
});

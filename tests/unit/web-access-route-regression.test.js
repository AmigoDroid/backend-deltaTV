import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ops = readFileSync(new URL('../../src/modules/provider-monitor/partner-operations.routes.js', import.meta.url), 'utf8');
const svc = readFileSync(new URL('../../src/modules/web/web-access.service.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('content partner Player Web list GET route exists', () => {
  assert.match(ops, /router\.get\("\/web-access",\s*validate\(/);
  assert.match(ops, /listWebAccesses\(req\.valid\.query,\s*\{\s*contentOwnerPartnerId:\s*req\.user\.partnerId\s*\}\)/);
});

test('content-owner listing is scoped by contentOwnerPartnerId', () => {
  assert.match(svc, /if \(scope\.contentOwnerPartnerId\) where\[Op\.and\]/);
});

test('migration commands use project config and migration folder', () => {
  for (const key of ['db:migrate', 'db:migrate:status', 'db:migrate:undo', 'db:migrate:undo:all']) {
    assert.match(pkg.scripts[key], /--config config\/sequelize-cli\.cjs/);
    assert.match(pkg.scripts[key], /--migrations-path src\/db\/migrations/);
  }
});

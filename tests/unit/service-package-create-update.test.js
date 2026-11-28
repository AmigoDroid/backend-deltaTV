import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const file = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('criação e edição de pacotes são endpoints distintos', () => {
  const routes=file('../../src/modules/service-packages/package.routes.js');
  assert.match(routes, /router\.post\('\/',validate\(\{body:schema\}\),async\(req,res\)=>res\.status\(201\)\.json\(await createServicePackage\(/);
  assert.match(routes, /router\.put\('\/:code'/);
  assert.match(routes, /await saveServicePackage\(req\.valid\.body,actorOf\(req\)\)/);
});

test('criação responde 409 para código existente sem ON CONFLICT DO UPDATE', () => {
  const code=file('../../src/modules/service-packages/package.service.js');
  assert.match(code, /export (?:async )?function createServicePackage\(/);
  assert.match(code, /'SERVICE_PACKAGE_ALREADY_EXISTS'/);
  assert.match(code, /ON CONFLICT\(code\) DO NOTHING RETURNING \*/);
  assert.match(code, /UPDATE partner_portal_sales_plans SET/);
  assert.doesNotMatch(code, /ON CONFLICT\(code\) DO UPDATE/);
});

test('duplicação de pacote usa criação estrita para não sobrescrever código', () => {
  const code=file('../../src/modules/service-packages/package.service.js');
  assert.match(code, /return createServicePackage\(\{code:newCode/);
  assert.match(code, /if\(!create&&!prior\?\.catalog_package\)notFound\(\)/);
});

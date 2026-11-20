import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=f=>readFileSync(new URL(`../../src/${f}`,import.meta.url),'utf8');
test('editor comercial legado aceita plano ativo de qualquer audience',()=>{
  const source=read('modules/partner-portal-sales/commercial-v2.service.js');
  assert.match(source,/if\(!tier\|\|!tier\.active\)fail\(422,'BAD_PACKAGE_TIER'/);
  assert.doesNotMatch(source,/includes\(tier\.audience\)/);
  assert.match(source,/SELECT key,audience,active FROM service_plan_catalogs/);
});
test('varredura de inadimplência lê candidatos em lotes e revalida dívida sob lock',()=>{
  const source=read('modules/billing/billing.service.js');
  const sweep=source.split('export async function sweepDelinquency')[1];
  assert.match(sweep,/offset \+= 250/);
  assert.match(sweep,/GROUP BY partner_id/);
  assert.match(sweep,/overdueByPartner\.get\(p\.id\)/);
  assert.match(sweep,/lock: t\.LOCK\.UPDATE/);
  assert.match(sweep,/currentOverdue = await overdueSinceFor\(p\.id, t\)/);
});
test('limite de sessões usa uma leitura por licença e mantém revogação em transação',()=>{
  const source=read('modules/superadmin/control.routes.js');
  assert.match(source,/activationId: \{ \[Op\.in\]: activations\.map\(a => a\.id\) \}/);
  assert.match(source,/byActivation\.get\(a\.id\)/);
  assert.match(source,/sessionsToRevoke\(/);
  assert.match(source,/where: \{ id: \{ \[Op\.in\]: ids \} \}, transaction/);
});

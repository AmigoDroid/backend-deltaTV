import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exactConfirmation,requiresReplacementOrExplicitRisk} from '../../src/modules/providers/deletion.policy.js';
const file=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
test('Confirmação exata bloqueia texto incorreto',()=>{
  assert.equal(exactConfirmation('5510','5510'),true);
  assert.equal(exactConfirmation('5511','5510'),false);
  assert.equal(exactConfirmation(undefined,'5510'),false);
});
test('Servidor em uso exige substituição ou consentimento expresso do impacto',()=>{
  assert.equal(requiresReplacementOrExplicitRisk(5,null,false),true);
  assert.equal(requiresReplacementOrExplicitRisk(5,null,true),false);
  assert.equal(requiresReplacementOrExplicitRisk(5,'substituto',false),false);
  assert.equal(requiresReplacementOrExplicitRisk(0,null,false),false);
});
test('Admin pode excluir códigos e servidores de qualquer parceria com escopo explícito e override',()=>{
  const s=file('../../src/modules/partners/partner.routes.js');
  assert.match(s,/codes\/:codeId\/deletion-preview", requirePermission\("override"\)/);
  assert.match(s,/providers\/:providerId\/deletion-preview",requirePermission\("override"\)/);
  assert.match(s,/deleteCodeOperational\(req\.valid\.params\.id/);
  assert.match(s,/deleteProviderOperational\(req\.valid\.params\.id/);
});
test('Revenda e parceiro usam apenas parceiro do token',()=>{
  const r=file('../../src/modules/portal/portal.routes.js');
  const c=file('../../src/modules/provider-monitor/monitor.routes.js');
  for(const s of [r,c]){
    assert.match(s,/deleteCodeOperational\(req\.user\.partnerId/);
    assert.match(s,/deleteProviderOperational\(req\.user\.partnerId/);
  }
});
test('Arquivamento não apaga licenças nem histórico financeiro',()=>{
  const s=file('../../src/modules/providers/operational-deletion.service.js');
  assert.match(s,/status:'revoked',deletedAt:new Date\(\)/);
  assert.match(s,/status:'disabled',deletedAt:new Date\(\)/);
  assert.doesNotMatch(s,/Activation\.destroy\(/);
  assert.doesNotMatch(s,/PartnerCode\.destroy\(/);
  assert.doesNotMatch(s,/PartnerProvider\.destroy\(/);
  assert.match(s,/CodeServerPool\.destroy/);
});
test('Migração cria exclusão lógica sem remover histórico',()=>{
  const s=file('../../src/db/migrations/20261218000001-code-provider-operational-deletion.cjs');
  assert.match(s,/ADD COLUMN IF NOT EXISTS deleted_at/);
  assert.match(s,/WHERE deleted_at IS NULL/);
  assert.doesNotMatch(s,/DROP TABLE/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planBenefits,planFingerprint,expirationFromPlan} from '../../src/modules/admin-workspaces/plan-entitlements.js';
const src=relative=>readFileSync(new URL(`../../src/${relative}`,import.meta.url),'utf8');
const basic={key:'n123',name:'Teste',active:true,monthlyPriceCents:0,maxServers:2,activationLimit:50,
 validityDays:7,autoPriority:false,autoFailover:true,emailAlerts:false,detailedHistory:false};
test('plano existente define valor, DNS, ativações e validade; R$ 0 permitido',()=>{
 const b=planBenefits(basic);
 assert.deepEqual(b,{monthlyFeeCents:0,dnsLimit:2,activationLimit:50,validityDays:7,autoPriority:false});
 assert.equal(expirationFromPlan(basic,new Date('2026-11-16T00:00:00Z')).toISOString(),'2026-11-23T00:00:00.000Z');
});
test('alterar preço ou limites invalida um convite antigo',()=>{
 assert.notEqual(planFingerprint(basic),planFingerprint({...basic,monthlyPriceCents:15000}));
 assert.notEqual(planFingerprint(basic),planFingerprint({...basic,activationLimit:null}));
 assert.notEqual(planFingerprint(basic),planFingerprint({...basic,active:false}));
});
test('cadastro usa uma fonte de benefícios e não usa estoque comercial',()=>{
 const s=src('modules/admin-workspaces/account-provisioning.js');
 for(const field of ['planBenefits(plan)','monthlyFeeCents:benefits.monthlyFeeCents','activationLimit:benefits.activationLimit','tier:plan.key'])assert.ok(s.includes(field),field);
 assert.doesNotMatch(s,/partner_portal_stock|receiveStock|available_months/);
 assert.ok(s.includes("benefits.monthlyFeeCents===0?'active':'suspended'"));
});
test('convite é limitado à rede e exige permissão ainda válida no aceite',()=>{
 const s=src('modules/admin-workspaces/network-invite-public.routes.js');
 for(const text of ["ownerAdminId:r.ownerAdminId",'ownerAllowed(r,t)','planFingerprint(plan)!==r.planFingerprint','lock:t.LOCK.UPDATE','inviteUnavailable(row)','AdminNetworkInviteRedemption.create'])assert.ok(s.includes(text),text);
 const admin=src('modules/admin-workspaces/network-invite-admin.routes.js');
 assert.match(admin,/tokenHash:HASH\(token\)/);
 assert.match(admin,/ownerAdminId:req\.networkOwnerId/);
});
test('plano pago nasce suspenso; admin ativa deliberadamente com auditoria e sem fingir pagamento',()=>{
 const s=src('modules/admin-workspaces/workspace.routes.js');
 assert.doesNotMatch(s,/PAYMENT_CONFIRMATION_REQUIRED/);
 assert.match(s,/activatedWithoutPayment:true/);
 assert.match(s,/confirmPendingContractFromWorkspace/);
 const ledger=src('modules/network-finance/finance.service.js');
 assert.match(ledger,/network\.finance\.charge\.paid/);
 assert.match(ledger,/method:'manual'/);
 assert.match(s,/network:billing:write/);
});

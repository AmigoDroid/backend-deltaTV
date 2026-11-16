import test from 'node:test';
import assert from 'node:assert/strict';
import {packageSnapshot,canGrantPermission,permissionsFromRow,canMoveUnder,isPaidInviteReady,PERMISSION_KEYS} from '../../src/modules/partner-portal-sales/commercial-v2.rules.js';

test('pacote congela todos os benefícios, revisões e limites',()=>{
 const p=packageSnapshot({code:'profissional',name:'Profissional',revision:3,service_tier:'partner_professional',max_dns:5,activation_limit:500,auto_failover:true,auto_priority:true,email_alerts:true,detailed_history:false});
 assert.deepEqual({dns:p.maxDns,activation:p.activationLimit,revision:p.revision}, {dns:5,activation:500,revision:3});
 assert.equal(p.autoPriority,true);
 assert.equal(p.detailedHistory,false);
});
test('DNS e ativações ilimitados não significam emissão gratuita',()=>{
 const p=packageSnapshot({code:'ilimitado',name:'Ilimitado',service_tier:'partner_premium',max_dns:null,activation_limit:null});
 assert.equal(p.maxDns,null);assert.equal(p.activationLimit,null);
 assert.equal(packageSnapshot({code:'antigo',service_tier:null}),null);
});
test('prioridade automática exige failover',()=>{
 assert.equal(packageSnapshot({code:'x',service_tier:'partner_premium',auto_priority:true,auto_failover:false}).autoPriority,false);
});
test('permissão não é delegável se o Master não a possui',()=>{
 const parent={active:true,can_sell:true,can_create_submasters:false,can_manage_gateways:true};
 assert.equal(canGrantPermission(parent,'canCreateSubmasters'),false);
 assert.equal(canGrantPermission(parent,'canManageGateways'),true);
 assert.equal(canGrantPermission(parent,'__proto__'),false);
});
test('desabilitar o vendedor torna todas as permissões invisíveis',()=>{
 const values=permissionsFromRow({active:false,can_sell:true,can_create_submasters:true,can_view_finance:true,can_manage_gateways:true});
 for(const key of PERMISSION_KEYS)assert.equal(values[key],false);
});
test('transferência de Submaster bloqueia ciclos hierárquicos',()=>{
 assert.equal(canMoveUnder({subjectId:'a',destinationId:'a',descendants:[]}),false);
 assert.equal(canMoveUnder({subjectId:'a',destinationId:'c',descendants:['b','c']}),false);
 assert.equal(canMoveUnder({subjectId:'a',destinationId:'d',descendants:['b','c']}),true);
});

test('convite novo manual exige baixa explícita; convite legado permanece compatível',()=>{
 assert.equal(isPaidInviteReady({package_snapshot:{code:'pro'},payment_gateway:'manual',payment_status:'unpaid'}),false);
 assert.equal(isPaidInviteReady({package_snapshot:{code:'pro'},payment_gateway:'manual',payment_status:'paid'}),true);
 assert.equal(isPaidInviteReady({package_snapshot:null,payment_gateway:'manual',payment_status:'unpaid'}),true);
 assert.equal(isPaidInviteReady({package_snapshot:null,payment_gateway:'mercadopago',payment_status:'unpaid'}),false);
 assert.equal(isPaidInviteReady({package_snapshot:{code:'pro'},payment_gateway:'infinitepay',payment_status:'paid'}),true);
});

import {personalizedPackage} from '../../src/modules/partner-portal-sales/commercial-v2.rules.js';
test('cadastro simples permite reduzir limite de ativações sem modificar pacote original',()=>{
 const p={code:'comercial',name:'Comercial',service_tier:'partner_professional',activation_limit:500,max_dns:5};
 assert.equal(personalizedPackage(p,100).activationLimit,100);
 assert.equal(p.activation_limit,500);
 assert.equal(personalizedPackage(p,undefined).activationLimit,500);
});
test('cadastro simples impede conceder ilimitado quando pacote tem teto',()=>{
 const p={code:'comercial',name:'Comercial',service_tier:'partner_professional',activation_limit:500,max_dns:5};
 assert.throws(()=>personalizedPackage(p,null),/superior/);
 assert.throws(()=>personalizedPackage(p,501),/superior/);
 assert.throws(()=>personalizedPackage(p,-1),/inválido/);
});
test('pacote sem teto aceita configuração individual ilimitada',()=>{
 const p={code:'comercial',name:'Comercial',service_tier:'partner_professional',activation_limit:null,max_dns:5};
 assert.equal(personalizedPackage(p,null).activationLimit,null);
 assert.equal(personalizedPackage(p,20).activationLimit,20);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {TIERS,defaultTier,featuresFor} from '../../src/modules/service-plans/plan.rules.js';

test('revenda básica não tem failover nem múltiplos servidores',()=>{
 const f=featuresFor('reseller_basic');assert.equal(f.maxServers,1);assert.equal(f.autoFailover,false);assert.equal(f.emailAlerts,false);
});
test('profissional permite até 4 URLs e failover, sem priorização dinâmica',()=>{
 const f=featuresFor('partner_professional');assert.equal(f.maxServers,4);assert.equal(f.autoFailover,true);assert.equal(f.autoPriority,false);
});
test('premium libera até 8 URLs, priorização e histórico',()=>{
 const f=featuresFor('partner_premium');assert.equal(f.maxServers,8);assert.equal(f.autoPriority,true);assert.equal(f.detailedHistory,true);
});
test('superadmin negocia limite e recursos individuais',()=>{
 const f=featuresFor('partner_professional',{maxServersOverride:6,autoPriorityOverride:true,emailAlertsOverride:false});
 assert.equal(f.maxServers,6);assert.equal(f.autoPriority,true);assert.equal(f.emailAlerts,false);
});
test('desabilitar failover também desabilita prioridade automática',()=>{
 const f=featuresFor('partner_premium',{autoFailoverOverride:false});assert.equal(f.autoFailover,false);assert.equal(f.autoPriority,false);
});
test('para novos cadastros, revenda inicia no básico e parceiro no profissional',()=>{
 assert.equal(defaultTier('reseller'),'reseller_basic');assert.equal(defaultTier('content'),'partner_professional');
});
test('limites inválidos são recusados',()=>{
 assert.throws(()=>featuresFor('partner_premium',{maxServersOverride:-1}));assert.throws(()=>featuresFor('fake'));
});

test('plano personalizado aplica recursos próprios sem depender de TIERS fixo',()=>{
 const catalog={name:'Parceiro Gold',maxServers:6,autoFailover:true,autoPriority:true,emailAlerts:true,detailedHistory:false};
 const f=featuresFor('parceiro_gold',{},catalog);
 assert.equal(f.maxServers,6);assert.equal(f.autoPriority,true);
 assert.equal(f.label,'Parceiro Gold');
});
test('exceções individuais sobrepõem o plano personalizado',()=>{
 const catalog={name:'Gold',maxServers:6,autoFailover:true,autoPriority:true,emailAlerts:true,detailedHistory:true};
 const f=featuresFor('parceiro_gold',{maxServersOverride:2,autoFailoverOverride:false},catalog);
 assert.equal(f.maxServers,2);assert.equal(f.autoFailover,false);assert.equal(f.autoPriority,false);
});


test('planos personalizados aceitam mais de oito URLs',()=>{
  const p={name:'Gold',maxServers:150,autoFailover:true,autoPriority:true,emailAlerts:true,detailedHistory:true};
  assert.equal(featuresFor('gold',{},p).maxServers,150);
  assert.equal(featuresFor('gold',{maxServersOverride:600},p).maxServers,600);
});
test('plano ilimitado e exceção de parceiro ilimitada',()=>{
  const p={name:'Ilimitado',maxServers:null,autoFailover:true,autoPriority:true,emailAlerts:true,detailedHistory:true};
  assert.equal(featuresFor('unlimited',{},p).maxServers,null);
  assert.equal(featuresFor('partner_professional',{maxServersOverride:0}).maxServers,null);
  assert.equal(featuresFor('unlimited',{maxServersOverride:3},p).maxServers,3);
});

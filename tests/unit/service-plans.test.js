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
 assert.throws(()=>featuresFor('partner_premium',{maxServersOverride:10}));assert.throws(()=>featuresFor('fake'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(`../../src/modules/provider-monitor/${p}`,import.meta.url),'utf8');
test('failover consulta o DNS dinâmico atual, não apenas o DNS fixo',()=>{
 const s=read('device-failover.service.js');
 assert.match(s,/selectedProviderForDevice\(activationId\)/);
 assert.doesNotMatch(s,/NO_SELECTED_PROVIDER.*monitoramento de seleção foi desativado/);
});
test('resolvedor grava apenas a rota atual e não devolve DNS sabidamente down',()=>{
 const s=read('resolve.service.js');
 assert.match(s,/rememberSelectedProvider\(activation\.id/);
 assert.match(s,/originalHealth\?\.state!=="down"/);
});
test('monitor notifica dispositivo após queda confirmada',()=>{
 const s=read('monitor.service.js');
 assert.match(s,/queueRefreshForDownProvider\(providerId\)/);
});
test('roteamento é único por ativação, sem tabela de eventos',()=>{
 const migration=readFileSync(new URL('../../src/db/migrations/20270105000001-device-active-provider-route.cjs',import.meta.url),'utf8');
 assert.match(migration,/activation_id: \{type:S\.UUID,allowNull:false,primaryKey:true/);
 assert.doesNotMatch(migration,/device_connection_events/);
});

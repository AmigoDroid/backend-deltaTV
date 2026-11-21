import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('prioridade emergencial tem prazo, código e não desliga failover',()=>{
 const migration=read('../../src/db/migrations/20270111000001-emergency-dns.cjs');
 const resolver=read('../../src/modules/provider-monitor/resolve.service.js');
 assert.match(migration,/code_dns_emergencies/);
 assert.match(migration,/expires_at/);
 assert.match(resolver,/code_id=:codeId AND expires_at>now\(\)/);
 assert.match(resolver,/forced\.id!==avoidId/);
 assert.match(resolver,/states\.get\(forced\.id\)\?\.state!=='down'/);
 assert.match(resolver,/if\(!ranked.length\)return fallback/);
});
test('operações garantem isolamento e acesso autenticado',()=>{
 const delegated=read('../../src/modules/admin-workspaces/workspace.routes.js');
 const superadmin=read('../../src/modules/admin.routes.js');
 const partner=read('../../src/modules/portal/portal.routes.js');
 assert.match(delegated,/emergencyRoutes\(async req=>\(await ownedPartner\(tenant\(req\),req\.params\.id\)\)\.id\)/);
 assert.match(delegated,/requireScope\('network:resources:write'\)/);
 assert.match(superadmin,/requirePermission\('partners:write'\)/);
 assert.match(partner,/emergencyRoutes\(req=>req\.user\.partnerId\)/);
});
test('avisos WSS e long-poll são restritos ao código',()=>{
 const wss=read('../../src/realtime/device-channel.js');
 const bus=read('../../src/realtime/change-bus.js');
 assert.match(wss,/if \(hint\.codeId && String\(hint\.codeId\) !== String\(codeId\)\)/);
 assert.match(wss,/codeId: activation\.partnerCodeId/);
 assert.match(wss,/readHints\(since, auth\.activationId, auth\.partnerId, auth\.codeId\)/);
 assert.match(bus,/codeId: msg\.codeId/);
 assert.doesNotMatch(bus,/password:|baseUrl:/);
});
test('monitor publica expiração e a API disponibiliza cancelamento',()=>{
 const monitor=read('../../src/modules/provider-monitor/monitor.service.js');
 const svc=read('../../src/modules/provider-monitor/emergency.service.js');
 const route=read('../../src/modules/provider-monitor/emergency.routes.js');
 assert.match(monitor,/notifyExpiredEmergencies\(\)/);
 assert.match(svc,/topic:'dns-emergency-end'/);
 assert.match(route,/r\.delete\('\/'/);
 assert.match(route,/mergeParams:true/);
});


test('troca emergencial é direito padrão do parceiro, inclusive sem autoFailover',()=>{
 const gate=read('../../src/middleware/authenticate.js');
 const svc=read('../../src/modules/provider-monitor/emergency.service.js');
 const resolve=read('../../src/modules/provider-monitor/resolve.service.js');
 const pool=read('../../src/modules/provider-monitor/code-pool.service.js');
 assert.match(gate,/first==='emergency-dns' && req\.user\?\.role==='partner'/);
 assert.doesNotMatch(svc,/PLAN_FAILOVER_DISABLED/);
 assert.match(svc,/Math\.max\(1,freshPlan\.features\.maxServers\)/);
 assert.match(resolve,/if\(!plan\.features\.autoFailover\)\{/);
 assert.match(resolve,/serversForCode\(code,\{bypassCache:true,emergency:true\}\)/);
 assert.match(resolve,/não ressuscitar a origem antiga removida/);
 assert.match(pool,/emergency = false/);
 assert.match(svc,/c\.partner_id=:partnerId/);
});

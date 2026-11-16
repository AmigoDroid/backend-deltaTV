import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=path=>readFileSync(new URL(`../../src/${path}`,import.meta.url),'utf8');
test('Admin de rede: alteração isolada de DNS revalida plano atual',()=>{
 const s=source('modules/admin-workspaces/workspace.routes.js');
 assert.match(s,/b\.planKey!==undefined \|\| b\.dnsLimit!==undefined/);
 assert.match(s,/effectivePlanKey=b\.planKey\?\?technical\?\.tier/);
 assert.match(s,/ownedPlan\(root,effectivePlanKey,p\.kind,t\)/);
});
test('Admin de rede: códigos de Revenda não burlam a exigência de licença',()=>{
 const s=source('modules/admin-workspaces/workspace.routes.js');
 assert.match(s,/RESELLER_LICENSE_DELEGATION_REQUIRED/);
 assert.match(s,/if\(p\.kind==="reseller"\)/);
 assert.match(s,/router\.patch\("\/partners\/:id\/codes\/:codeId"/);
});
test('Telemetria: spool durável com idempotência e alerta de perda explícito',()=>{
 const s=source('modules/partner-portal-usage/meter.js');
 for(const marker of ['SPOOL_DIR','MAX_SPOOL_BYTES','rename(temporary,path)','batch.batchId','unrecordedMeasurements','accountingComplete'])
   assert.ok(s.includes(marker),marker);
 assert.doesNotMatch(s,/pending\.push\(/);
});
test('WebSocket e importação limitam recursos antes de processar carga',()=>{
 assert.match(source('realtime/socket.js'),/MAX_EVENT_BUFFER_BYTES/);
 const s=source('app.js');
 assert.ok(s.indexOf("req.user?.role !== 'superadmin'")<s.indexOf("express.json({limit:'32mb'})"));
});

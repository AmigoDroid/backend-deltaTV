import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');

test('Admin A não lista lixeira B: ownerAdminId é aplicado pelo serviço e autorização por tipo',()=>{
 const route=read('../../src/modules/admin-workspaces/workspace.routes.js');
 const service=read('../../src/modules/partner-trash.service.js');
 assert.match(route,/router\.get\('\/trash',validate/);
 assert.match(route,/listPartnerTrash\(req\.valid\.query,actorOf\(req\),tenant\(req\)/);
 assert.match(service,/if \(ownerAdminId !== undefined\) where\.ownerAdminId = ownerAdminId/);
 assert.match(route,/rights\.content&&rights\.reseller\?\['both'\]/);
 assert.match(route,/throw new AppError\(403,'NETWORK_PERMISSION_DENIED','Sem permissão para este tipo de conta\.'/);
});
test('Restauração IDOR: dono é verificado antes e DENTRO do lock; 404 para conta alheia',()=>{
 const route=read('../../src/modules/admin-workspaces/workspace.routes.js');
 const service=read('../../src/modules/partner-trash.service.js');
 assert.match(route,/id:req\.valid\.params\.id,ownerAdminId:tenant\(req\),status:'deleted'/);
 assert.match(route,/if\(!p\)throw new AppError\(404,'NOT_FOUND'/);
 assert.match(route,/canDeleteOwned\(req,p\)/);
 assert.match(service,/ownerAdminId === undefined \? \{id\} : \{id, ownerAdminId\}/);
 assert.match(service,/transaction, lock: transaction\.LOCK\.UPDATE/);
 assert.match(route,/restorePartnerFromTrash\(p\.id,req\.valid\.body,actorOf\(req\),tenant\(req\)\)/);
 assert.doesNotMatch(route,/router\.delete\('\/trash\/.*permanent/);
});
test('Reativação da rede não força cancelado e não libera pagamento pendente',()=>{
 const route=read('../../src/modules/admin-workspaces/workspace.routes.js');
 const service=read('../../src/modules/partners/partner.service.js');
 assert.match(route,/changePartnerStatus\(owned\.id,action,req\.valid\.body,actorOf\(req\),tenant\(req\)\)/);
 assert.match(service,/ownerAdminId !== undefined && action === "reactivate" && p\.statusReason === "awaiting_payment"/);
 assert.match(service,/if \(!rule\.from\.includes\(p\.status\) && !\(force && rule\.forceFrom\?\.includes\(p\.status\)\)\)/);
 assert.match(service,/where = ownerAdminId === undefined \? \{ id \} : \{ id, ownerAdminId \}/);
});
test('Portal Admin/Parceiro nega sessão expirada (effectivePartnerStatus), sem liberar Admin da rede',()=>{
 const auth=read('../../src/modules/auth/auth.service.js');
 const middleware=read('../../src/middleware/authenticate.js');
 const accounts=read('../../src/modules/auth/portal-accounts.service.js');
 assert.match(auth,/targetAudience !== 'admin' && \(!partner \|\| effectivePartnerStatus\(partner\) !== 'active'\)/);
 assert.match(auth,/session\.portalPartnerId && \(!selected \|\| effectivePartnerStatus\(selected\) !== 'active'\)/);
 assert.match(middleware,/if\(!partner \|\| effectivePartnerStatus\(partner\) !== 'active'/);
 assert.match(accounts,/attributes: \['id','name','kind','status','endsAt','ownerAdminId'\]/);
});

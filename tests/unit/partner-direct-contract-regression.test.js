import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src = path=>readFileSync(new URL(path,import.meta.url),'utf8');
test('Cadastro único mantém contrato e conta dentro da mesma transação',()=>{
 const routes=src('../../src/modules/partners/partner.routes.js');
 const service=src('../../src/modules/partners/partner.service.js');
 assert.match(routes,/serviceContract: serviceContractInput\.optional\(\)/);
 assert.match(routes,/DELTATV_ONLY/);
 assert.match(service,/sequelize\.transaction\(async \(t\) =>/);
 assert.match(service,/if \(serviceContract\) await applyServiceContract\(t,partner,serviceContract,data\.monthlyFeeCents,actor\)/);
 assert.match(service,/ContentPartnerTerms\.create\(\{partnerId:partner\.id,\.\.\.terms\},\{transaction:t\}\)/);
 assert.match(service,/PartnerServicePlan\.create\(\{partnerId:partner\.id/);
 assert.match(service,/await p\.update\(input, \{ transaction: t \}\)/);
 assert.match(service,/LIMIT_BELOW_USAGE/);
 assert.match(service,/DNS_LIMIT_BELOW_USAGE/);
});
test('Nenhum novo convite de revenda pode ser criado e antigos podem ser concluídos',()=>{
 const routes=src('../../src/modules/partner-portal-sales/sales.routes.js');
 assert.match(routes,/PARTNER_RESALE_DISABLED/);
 assert.match(routes,/'\/invitations'/);
 assert.match(routes,/publicPortalSalesInvitations\.post\('\/complete'/);
 assert.match(routes,/portalSalesWebhook/);
});

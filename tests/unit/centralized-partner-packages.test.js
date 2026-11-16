import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=rel=>readFileSync(new URL(`../../src/${rel}`,import.meta.url),'utf8');
const admin=rel=>readFileSync(new URL(`../../../admin/src/${rel}`,import.meta.url),'utf8');
const partner=rel=>readFileSync(new URL(`../../../painel_parceiro/src/${rel}`,import.meta.url),'utf8');

test('Pacotes de Serviço são centralizados e reaproveitam os contratos técnicos existentes',()=>{
 const route=src('modules/admin.routes.js');
 assert.match(route,/router\.use\("\/service-packages",servicePackages\)/);
 assert.match(route,/router\.use\("\/global-config",globalConfig\)/);
 const apply=src('modules/service-packages/package.apply.js');
 assert.match(apply,/INSERT INTO partner_service_plans/);
 assert.match(apply,/INSERT INTO content_partner_terms/);
 assert.match(apply,/INSERT INTO partner_service_package_assignments/);
 const commercial=src('modules/partner-portal-sales/commercial-v2.service.js');
 const invitations=src('modules/partner-portal-sales/invitations.service.js');
 assert.match(commercial,/applyServicePackageToPartner\(/);
 assert.match(invitations,/applyServicePackageToPartner\(/);
});
test('convites comerciais novos não exigem nem consomem estoque e preservam histórico antigo',()=>{
 const invitations=src('modules/partner-portal-sales/invitations.service.js');
 assert.match(invitations,/paymentTotal,false\) RETURNING/);
 assert.doesNotMatch(invitations,/UPDATE partner_portal_stock SET available_months=available_months-:months/);
 assert.match(invitations,/if\(released\.stock_reserved\)/);
 const sales=src('modules/partner-portal-sales/sales.service.js');
 assert.match(sales,/if\(!order\.service_access_only\)await receiveStock/);
 const routes=src('modules/partner-portal-sales/sales.routes.js');
 for(const endpoint of ['/orders','/contracts','/transfers','/renewals'])assert.match(routes,new RegExp(`(?:adminPortalSales|partnerPortalSales)\\.post\\('${endpoint}'.*LEGACY_PORTAL_STOCK_DISABLED`));
});
test('cadastro de parceiro DeltaTV é o único fluxo visível de contrato e limites',()=>{
 const shell=partner('App.jsx');
 const page=admin('pages/Partners.jsx');
 assert.doesNotMatch(shell,/PortalSales|MyServicePackage|commercialPermissions/);
 assert.match(page,/Novo parceiro/);
 assert.match(page,/serviceContract:\{activationLimit:max,dnsLimit:dns,licensePolicy:f\.licensePolicy\}/);
 assert.match(page,/Mensalidade negociada/);
 assert.match(page,/Ativações ilimitadas/);
 assert.match(page,/Limite de DNS por código/);
 const settings=admin('pages/GlobalSettings.jsx');
 for(const text of ['Pagamentos e webhooks','Teste grátis','Player Web','Custos e margem'])assert.ok(settings.includes(text));
});
test('configurações de pacote e ambiente são exclusivas da DeltaTV no backend',()=>{
 for(const file of ['modules/service-packages/package.routes.js','modules/platform-config/config.routes.js']){
  const code=src(file);assert.match(code,/req\.user\?\.role!=='superadmin'/);assert.match(code,/req\.impersonator/);
 }
});

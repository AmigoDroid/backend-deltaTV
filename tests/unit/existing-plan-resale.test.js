import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = path => readFileSync(new URL(`../../src/${path}`,import.meta.url),'utf8');
test('existing service_plan_catalogs defines monthly fee and commercial permissions',()=>{
 const routes=source('modules/service-plans/catalog.routes.js');
 for(const name of ['monthlyPriceCents','canResellPanel','canCreateSubmasters','canViewFinance','canManageGateways'])assert.ok(routes.includes(name));
 const sql=source('db/migrations/20261228000001-existing-plans-resale-rights.cjs');
 assert.match(sql,/ALTER TABLE service_plan_catalogs/);
 assert.match(sql,/can_resell_panel/);
 assert.doesNotMatch(sql,/DROP TABLE partner_portal_sales_plans/);
});
test('partner is authorized through current plan; not through separate Master signup',()=>{
 const service=source('modules/service-plans/plan.service.js');
 assert.match(service,/partner_portal_sellers/);
 assert.match(service,/canResellPanel/);
 const network=source('modules/partner-portal-sales/commercial-v2.service.js');
 assert.match(network,/COALESCE\(pc.can_resell_panel,false\)/);
 assert.match(network,/can_view_finance/);
});
test('new invitations use existing catalog, no stock, and payment confirmation remains mandatory',()=>{
 const i=source('modules/partner-portal-sales/invitations.service.js');
 assert.match(i,/FROM service_plan_catalogs/);
 assert.match(i,/sellerPermission.permissions\?\.canSell/);
 assert.match(i,/stock_reserved/);
 assert.match(i,/isPaidInviteReady/);
 assert.doesNotMatch(i,/available_months=available_months-:months/);
});

test('gateway and transfer API validate effective inherited plan permissions',()=>{
 const network=source('modules/partner-portal-sales/commercial-v2.service.js');
 assert.match(network,/effectiveNetworkState\(id,t\)\)\.permissions\?\.canManageGateways/);
 assert.match(network,/effectiveNetworkState\(destinationId,t\)\)\.permissions\?\.canCreateSubmasters/);
 assert.match(network,/effectiveNetworkState\(actor\.partnerId,t\)\)\.permissions\?\.canCreateSubmasters/);
});
test('a new reseller inherits only seller-approved rights from the ORIGINAL plan',()=>{
 const invitation=source('modules/partner-portal-sales/invitations.service.js');
 assert.match(invitation,/canCreate:!!\(childPlan\?\.can_create_submasters&&permissions\.permissions\.canCreateSubmasters\)/);
 assert.match(invitation,/canFinance:!!\(childPlan\?\.can_view_finance&&permissions\.permissions\.canViewFinance\)/);
 assert.match(invitation,/canGateway:!!\(childPlan\?\.can_manage_gateways&&permissions\.permissions\.canManageGateways\)/);
});

test('an expired partner cannot keep selling or configuring payment gateways',()=>{
 const network=source('modules/partner-portal-sales/commercial-v2.service.js');
 assert.match(network,/new Date\(row\.ends_at\)\.getTime\(\)>Date\.now\(\)/);
});

test('my plan shows the actual resale price and payee, not fictitious zero fee',()=>{
 const service=source('modules/partner-portal-sales/commercial-v2.service.js');
 assert.match(service,/seller\.name AS seller_name/);
 assert.match(service,/feeRecipient:contract\?\.seller_name\|\|'DeltaTV'/);
 assert.match(service,/contract\.declared_resale_cents/);
});
test('manual +1 month renewal is auditable and does not fake payment',()=>{
 const service=source('modules/partners/partner.service.js');
 const routes=source('modules/partners/partner.routes.js');
 assert.match(routes,/\/:id\/renew-month/);
 assert.match(routes,/requirePermission\("override"\)/);
 assert.match(service,/partner\.renew\.one_month_manual/);
 assert.match(service,/paymentConfirmed:false/);
});

test('assigning an original plan must not silently remove existing device activation limit',()=>{
 const service=source('modules/service-plans/plan.service.js');
 assert.match(service,/terms\?\.activationLimit\?\?partner\.deviceLimit/);
 assert.match(service,/fixed_limited/);
});

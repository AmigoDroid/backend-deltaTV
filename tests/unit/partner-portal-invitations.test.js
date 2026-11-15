import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PORTAL_INVITE_TTL_MS,PORTAL_INVITE_TYPES,normalizePortalInviteEmail,verifyPortalInviteInput,portalInviteUrl}
 from '../../src/modules/partner-portal-sales/invitations.rules.js';
const root=new URL('../../src/',import.meta.url);
const source=path=>readFileSync(new URL(path,root),'utf8');

test('convites comerciais usam janela de 72h, token em HTTPS e rota separada da pré-inscrição legada',()=>{
 assert.equal(PORTAL_INVITE_TTL_MS,72*3600*1000);
 assert.equal(portalInviteUrl('https://parceiro.deltatv.com.br/','a'.repeat(42)),`https://parceiro.deltatv.com.br/convite-comercial#token=${'a'.repeat(42)}`);
 assert.throws(()=>portalInviteUrl('http://parceiro.deltatv.com.br','a'.repeat(42)));
 assert.throws(()=>portalInviteUrl('https://parceiro.deltatv.com.br','123'));
});
test('submaster também deve contratar meses pré-pagos de acesso ao painel',()=>{
 assert.deepEqual(PORTAL_INVITE_TYPES,['customer','submaster']);
 for(const inviteType of PORTAL_INVITE_TYPES)assert.equal(verifyPortalInviteInput({inviteType,months:1,unitResaleCents:1200},{min_resale_cents:1200}),true);
 assert.throws(()=>verifyPortalInviteInput({inviteType:'revenda',months:1,unitResaleCents:1200},{min_resale_cents:1200}));
});
test('não vende plano abaixo do piso nem reserva duração inválida',()=>{
 assert.throws(()=>verifyPortalInviteInput({inviteType:'customer',months:0,unitResaleCents:1200},{min_resale_cents:1200}));
 assert.throws(()=>verifyPortalInviteInput({inviteType:'customer',months:121,unitResaleCents:1200},{min_resale_cents:1200}));
 assert.throws(()=>verifyPortalInviteInput({inviteType:'customer',months:12,unitResaleCents:1199},{min_resale_cents:1200}));
 assert.equal(normalizePortalInviteEmail('  TESTE@Example.COM  '),'teste@example.com');
});
test('migração aditiva mantém licença de TV e contratos existentes intocados',()=>{
 const migration=readFileSync(new URL('../../src/db/migrations/20261222000001-partner-portal-invitations.cjs',import.meta.url),'utf8');
 assert.match(migration,/CREATE TABLE partner_portal_sales_invitations/);
 assert.match(migration,/ON DELETE RESTRICT/);
 assert.match(migration,/WHERE status='pending'/);
 assert.doesNotMatch(migration,/DROP TABLE|TRUNCATE|DELETE FROM partner_portal_access_contracts|UPDATE licenses/i);
});
test('reservas são debitadas ao emitir, devolvidas quando revogadas ou expiradas e não debitadas novamente no aceite',()=>{
 const service=source('modules/partner-portal-sales/invitations.service.js');
 assert.match(service,/UPDATE partner_portal_stock SET available_months=available_months-:months/);
 assert.match(service,/UPDATE partner_portal_stock SET available_months=available_months\+:months/);
 assert.match(service,/if\(row.status!==['"]pending['"]\)/);
 assert.match(service,/status='accepted'/);
 assert.match(service,/stockAlreadyReserved:true/);
 assert.doesNotMatch(service,/\b(?:License|Activation|license_stock|reseller_network)\b/);
});
test('aceite cria parceiro de conteúdo e contrato na mesma transação; link só pode ser usado uma vez',()=>{
 const service=source('modules/partner-portal-sales/invitations.service.js');
 assert.match(service,/const passwordHash=await hashPassword\(password\);\s*return tx\(async t/);
 assert.match(service,/Partner\.create\(/);
 assert.match(service,/AdminUser\.create\(/);
 assert.match(service,/INSERT INTO partner_portal_access_contracts/);
 assert.match(service,/INSERT INTO partner_portal_contract_events/);
 assert.match(service,/row\.status!=='pending'/);
 assert.match(service,/token_hash=:consumedHash/);
});
test('Master só cria convite com a própria identidade e nenhuma rota pública cria estoque',()=>{
 const routes=source('modules/partner-portal-sales/sales.routes.js');
 const service=source('modules/partner-portal-sales/invitations.service.js');
 assert.match(service,/actor\?\.type!=='partner'/);
 assert.match(service,/actor\?\.partnerId!==id/);
 assert.match(routes,/partnerPortalSales\.post\('\/invitations',stockWriteLimiter/);
 assert.match(routes,/publicPortalSalesInvitations\.post\('\/complete',signupLimiter/);
 assert.match(routes,/sellerPartnerId:req\.user\.partnerId/);
});

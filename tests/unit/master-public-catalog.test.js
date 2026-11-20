import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSelfServiceUpgrade } from '../../src/modules/network-finance/upgrade-eligibility.js';

const source=readFileSync(new URL('../../src/modules/network-finance/pricing.service.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('export async function partnerUpgradeOptions('),source.indexOf('export async function quotePartnerUpgrade('));
const base={key:'starter',active:true,deletedAt:null,hiddenFromNetwork:false,monthlyPriceCents:4500,maxServers:2,
 activationLimit:20,validityDays:30,autoFailover:false,autoPriority:false,emailAlerts:false,detailedHistory:false,
 canResellPanel:false,canCreateSubmasters:false,canViewFinance:false,canManageGateways:false};

test('ofertas públicas pertencem somente ao Master do parceiro e excluem planos ocultos',()=>{
 assert.match(fn,/ownerAdminId:partner\.ownerAdminId,active:true,deletedAt:null,hiddenFromNetwork:false/);
 assert.match(fn,/key:service\.tier,ownerAdminId:partner\.ownerAdminId/);
 assert.doesNotMatch(fn,/ownerAdminId:null/);
});

test('catálogo retorna todos os planos públicos, mas só oferece upgrade permitido',()=>{
 assert.match(fn,/plans:publicPlans\.map\(p=>/);
 assert.match(fn,/isCurrent:p\.key===current\?\.key/);
 assert.match(fn,/canUpgrade:available&&isSelfServiceUpgrade\(baseline,p\)/);
 assert.equal(isSelfServiceUpgrade(base,{...base,key:'higher',monthlyPriceCents:7500,maxServers:4}),true);
 assert.equal(isSelfServiceUpgrade(base,{...base,key:'lower',monthlyPriceCents:3000}),false);
 assert.equal(isSelfServiceUpgrade(base,{...base,key:'hidden',hiddenFromNetwork:true,monthlyPriceCents:7500}),false);
});

test('não confunde recursos do plano com os limites e preços da DeltaTV central',()=>{
 assert.match(fn,/terms\?\.mode!=='credits'/);
 assert.match(fn,/contractPriceCents:baseline\.monthlyPriceCents/);
 assert.match(fn,/canResellPanel:p\.canResellPanel/);
 assert.match(fn,/canManageGateways:p\.canManageGateways/);
 assert.match(fn,/emailAlerts:p\.emailAlerts/);
 assert.match(fn,/detailedHistory:p\.detailedHistory/);
});

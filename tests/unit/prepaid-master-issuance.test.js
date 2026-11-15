import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { totalPrepaidCredits } from '../../src/modules/distribution/prepaid-issuance.policy.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url),'utf8');

test('emissão exige preço positivo e montante inteiro seguro', () => {
  assert.equal(totalPrepaidCredits(8,3),24);
  assert.equal(totalPrepaidCredits(1,10000),10000);
  assert.equal(totalPrepaidCredits(0,2),null);
  assert.equal(totalPrepaidCredits(-1,2),null);
  assert.equal(totalPrepaidCredits(10,0),null);
  assert.equal(totalPrepaidCredits(10,10001),null);
  assert.equal(totalPrepaidCredits(1.5,2),null);
  assert.equal(totalPrepaidCredits(Number.MAX_SAFE_INTEGER,2),null);
});

test('emissão de estoque do Master debita créditos antes da entrada em estoque dentro de uma transação', () => {
  const code = read('../../src/modules/distribution/master-issuance.service.js');
  assert.match(code,/sequelize\.transaction\(async transaction/);
  assert.match(code,/debitPrepaidIssuance\(transaction/);
  assert.ok(code.indexOf('debitPrepaidIssuance(transaction') < code.indexOf('const balanceAfter=await move(transaction'));
  assert.match(code,/idempotency_key/);
  assert.match(code,/unit_price_credits,total_credits,credit_balance_after/);
});

test('aplicação direta por Master debita após checar idempotência e antes de aplicar licença', () => {
  const code=read('../../src/modules/stock/direct-device-activation.service.js');
  const replay=code.indexOf('if (request.result) return');
  const debit=code.indexOf('debitPrepaidIssuance(transaction');
  const apply=code.indexOf('const applied = await applyOnce(');
  assert.ok(replay>0 && replay<debit && debit<apply);
  assert.match(code,/issuerType === "admin" && actor\?\.role !== "superadmin"/);
});

test('ajustes positivos de estoque e crédito exigem Superadmin, sem alterar consumo de estoque', () => {
  const stock=read('../../src/modules/stock/stock.service.js');
  const credits=read('../../src/modules/credits/credit.service.js');
  assert.match(stock,/delta > 0 && actor\?\.role !== "superadmin"/);
  assert.match(stock,/actor\?\.role !== "superadmin"/);
  assert.match(credits,/delta > 0 && actor\?\.role !== "superadmin"/);
  assert.match(stock,/sequelize, Partner, AdminUser, License, Activation, Renewal, LicenseStockLedger, Device/);
});

test('regras de preços dos créditos são administradas pelo Superadmin', () => {
  const credits=read('../../src/modules/credits/credit.service.js');
  for (const name of ['setPrice','deletePrice','setRate','deleteRate']) {
    const functionBody=credits.split(`export async function ${name}(`)[1];
    assert.ok(functionBody,`falta função ${name}`);
    assert.match(functionBody.slice(0,500),/actor\?\.role !== "superadmin"/);
  }
});

test('migração é aditiva e preserva informações legadas com NULL', () => {
  const migration=read('../../src/db/migrations/20261216000001-prepaid-master-issuance.cjs');
  assert.match(migration,/ADD COLUMN IF NOT EXISTS unit_price_credits/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS total_credits/);
  assert.doesNotMatch(migration,/DROP TABLE|DELETE FROM reseller_master_issuance_requests/);
});

test('emissões e renovações manuais e cortesias de PlayerWeb ficam só para Superadmin', () => {
  const license=read('../../src/modules/licenses/license.service.js');
  const web=read('../../src/modules/web/web-access.service.js');
  for (const method of ['createLicense','renewLicense']) {
    const body=license.split(`export async function ${method}(`)[1];
    assert.ok(body,`falta ${method}`);
    assert.match(body.slice(0,700),/actor\?\.role !== "superadmin"/);
  }
  assert.match(web,/if \(!useStock && actor\?\.role !== "superadmin"\)/);
  assert.match(web,/financialProvenance:"superadmin_exception"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {oneOffQuote} from '../../src/modules/network-finance/one-off.js';
import migration from '../../src/db/migrations/20270114000001-network-one-off-charges.cjs';
import {requiredSettlementCents} from '../../src/modules/network-finance/charge-pricing.js';

const adminId='11111111-1111-4111-8111-111111111111';
const partnerId='22222222-2222-4222-8222-222222222222';
const input={adminId,partnerId,amountCents:4990,description:'Serviço adicional de instalação',method:'automatic'};
test('avulsa mantém preço em centavos sem alterar plano, vencimento, juros ou benefícios',()=>{
 const quote=oneOffQuote(input,new Date('2026-11-20T10:00:00Z'));
 assert.equal(quote.kind,'one_off');assert.equal(quote.amountCents,4990);
 assert.equal(quote.planFrom,null);assert.equal(quote.planTo,null);
 assert.deepEqual([quote.breakdown.earlyDiscountCents,quote.breakdown.lateFeeCents,quote.breakdown.interestCents],[0,0,0]);
 assert.equal(quote.breakdown.totalCents,4990);
 assert.equal(requiredSettlementCents(quote.breakdown,new Date('2026-11-22T00:00:00Z')),4990);
 assert.equal(Object.isFrozen(quote.breakdown),true);
});
test('valor de avulsa só aceita inteiro seguro positivo e mínimo de R$ 1',()=>{
 for(const amountCents of [0,99,1.1,Number.MAX_SAFE_INTEGER,Infinity,-200,'5000',null])
  assert.throws(()=>oneOffQuote({...input,amountCents}),RangeError);
 assert.equal(oneOffQuote({...input,amountCents:100}).amountCents,100);
});
test('descrição obrigatória e sem quebras de linha',()=>{
 for(const description of ['', 'a', 'A'.repeat(201),'linha\ninjetada','linha\rinjetada'])
  assert.throws(()=>oneOffQuote({...input,description}),RangeError);
});
test('prévia invalida mudança de valor, motivo, destinatário, método e titular',()=>{
 const fp=oneOffQuote(input).previewFingerprint;
 for(const change of [{amountCents:4000},{description:'Serviço diferente'},{partnerId:adminId},
  {adminId:partnerId},{method:'manual'}])
  assert.notEqual(oneOffQuote({...input,...change}).previewFingerprint,fp);
 assert.equal(oneOffQuote({...input}).previewFingerprint,fp);
});
test('não existe confirmação automática por método desconhecido',()=>{
 assert.throws(()=>oneOffQuote({...input,method:'fake'}),RangeError);
});
test('migration avulsa modifica constraints/índices sem tocar dados e rollback recusa histórico',async()=>{
 const statements=[];
 const q={sequelize:{transaction:async f=>f({}),query:async sql=>{
   statements.push(sql);
   if(sql.includes('SELECT count(*)::int AS n'))return [[{n:2}],null];
   return [[],null];
 }}};
 await migration.up(q);
 assert.match(statements.join('\n'),/one_off/);
 assert.match(statements.join('\n'),/ux_network_charge_partner_one_off_open/);
 await assert.rejects(migration.down(q),/histórico financeiro/);
});

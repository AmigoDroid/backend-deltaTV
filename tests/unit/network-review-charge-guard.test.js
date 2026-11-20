import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const migration=require('../../src/db/migrations/20270113000001-network-review-charge-exclusivity.cjs');
test('índice de cobranças em revisão é único e reversível; dados conflitantes bloqueiam up',async()=>{
 const commands=[];
 const q={sequelize:{transaction:fn=>fn({}),query:async sql=>commands.push(sql)}};
 await migration.up(q);await migration.down(q);
 assert.match(commands[0],/HAVING count\(\*\)>1/);
 assert.match(commands[0],/needs_review/);
 assert.match(commands[0],/CREATE UNIQUE INDEX ux_network_charge_partner_open/);
 assert.match(commands[1],/WHERE status IN \('creating','pending'\)/);
});
test('falha ambígua na criação não libera a cobrança para segundo Pix',()=>{
 const src=readFileSync(new URL('../../src/modules/network-finance/finance.service.js',import.meta.url),'utf8');
 const block=src.slice(src.indexOf('export async function createCharge'),src.indexOf('async function settleCharge'));
 assert.match(block,/review_reason='PROVIDER_CREATE_RESPONSE_UNKNOWN'/);
 assert.doesNotMatch(block,/SET status='failed'/);
});

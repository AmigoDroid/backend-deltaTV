import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/** Regression test for Sequelize named replacements adjacent to SQL operators.
 * When there is no separator between '<' or '<>' and ':parameter', the
 * Sequelize replacement lexer can leave the colon in the SQL sent to Postgres.
 * PostgreSQL then raises 42601, with the error position pointing at ':'.
 * Covers all three usage reports and the commerce commissions query.
 */
test('all three portal usage queries separate operators from named parameters',()=>{
  const source=readFileSync(new URL('../../src/modules/partner-portal-usage/usage.service.js',import.meta.url),'utf8');
  const safe=source.match(/bucket_at >= :start AND bucket_at < :end/g)||[];
  assert.equal(safe.length,3,'usage, daily and devices each need a safe date predicate');
  assert.doesNotMatch(source,/bucket_at\s*<:end\b/);
});

test('commission SQL separates <> from its named replacement',()=>{
  const source=readFileSync(new URL('../../src/modules/commerce/commission.service.js',import.meta.url),'utf8');
  assert.match(source,/beneficiary_partner_id <> :beneficiaryId\b/);
  assert.doesNotMatch(source,/beneficiary_partner_id\s*<>:beneficiaryId\b/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateChargePricing } from '../../src/modules/network-finance/charge-pricing.js';
import { upgradePlanSignature } from '../../src/modules/network-finance/upgrade-eligibility.js';

test('prévia de upgrade R$ 0 → R$ 16.000 preserva o cálculo congelado e adiciona metadados sem TypeError', () => {
  const result = calculateChargePricing({
    kind: 'upgrade', planPriceCents: 1_600_000, oldPlanPriceCents: 0,
    validityDays: 30, endsAt: null, now: new Date('2026-11-20T12:00:00.000Z'),
  });
  assert.equal(result.totalCents, 1_600_000);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.selfServiceUpgrade = true; }, TypeError);
  const plan = { key: 'ilimitado-16000', monthlyPriceCents: 1_600_000, validityDays: 30 };
  const breakdown = { ...result, selfServiceUpgrade: true, upgradePlanSignature: upgradePlanSignature(plan) };
  assert.equal(breakdown.selfServiceUpgrade, true);
  assert.equal(breakdown.totalCents, 1_600_000);
  assert.equal(breakdown.upgradePlanSignature, upgradePlanSignature(plan));
  assert.equal(result.selfServiceUpgrade, undefined);
  const source = readFileSync(new URL('../../src/modules/network-finance/pricing.service.js', import.meta.url), 'utf8');
  assert.match(source, /breakdown\s*=\s*\{\s*\.\.\.breakdown\s*,\s*selfServiceUpgrade\s*:\s*true/);
  assert.doesNotMatch(source, /breakdown\.selfServiceUpgrade\s*=/);
});

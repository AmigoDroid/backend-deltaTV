/** Regras puras de planos e comissões. Valores monetários e créditos são inteiros. */
export function commissionCredits(totalCredits, basisPoints) {
  if (!Number.isSafeInteger(totalCredits) || totalCredits < 0 ||
      !Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw new RangeError('Créditos ou percentual inválido');
  // Evita imprecisão do produto de números grandes via BigInt.
  const value = (BigInt(totalCredits) * BigInt(basisPoints)) / 10_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Comissão fora do intervalo');
  return Number(value);
}
export function availableSlots(limit, used) {
  if (!Number.isSafeInteger(used) || used < 0) throw new RangeError('Ocupação inválida');
  if (limit === null) return null; // null = ilimitado, zero = nenhuma vaga
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('Quantidade inválida');
  return Math.max(0, limit - used);
}
export function entitlementState({ state, graceDays, dueAt }, now = new Date()) {
  if (['cancelled','suspended'].includes(state)) return state;
  if (state === 'draft') return 'draft';
  if (!dueAt) return state;
  const d = new Date(dueAt).getTime();
  if (!Number.isFinite(d)) return 'invalid';
  if (d >= now.getTime()) return 'active';
  if (d + graceDays * 86400_000 >= now.getTime()) return 'past_due';
  return 'restricted'; // aplicação da suspensão posterior exige política e reconciliação
}

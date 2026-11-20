import { createHash } from 'node:crypto';

/** A cobrança avulsa é independente do contrato; nunca concede dias, licenças ou créditos. */
export function oneOffQuote({adminId,partnerId,amountCents,description,method='automatic'},now=new Date()) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 100_000_000)
    throw new RangeError('A cobrança avulsa deve ser de R$ 1,00 a R$ 1.000.000,00.');
  const text=String(description||'').trim();
  if (text.length<5 || text.length>200 || /[\r\n]/.test(text))
    throw new RangeError('Informe uma descrição de 5 a 200 caracteres, sem quebras de linha.');
  if(!['automatic','manual'].includes(method))throw new RangeError('Método de cobrança inválido.');
  const previewFingerprint=createHash('sha256').update(JSON.stringify([adminId,partnerId,amountCents,text,method])).digest('hex');
  const breakdown=Object.freeze({version:1,kind:'one_off',description:text,baseCents:amountCents,totalCents:amountCents,
    earlyDiscountCents:0,manualDiscountCents:0,lateFeeCents:0,interestCents:0,waiverFeeCents:0,waiverInterestCents:0,
    chargedAt:new Date(now).toISOString()});
  return {kind:'one_off',planFrom:null,planTo:null,amountCents,description:text,breakdown,previewFingerprint};
}

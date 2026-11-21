/** Motor puro de preços em centavos inteiros. Nunca usa valores informados pelo pagador. */
export const PRICING_ZONE = 'America/Sao_Paulo';
export const DEFAULT_CAPS = Object.freeze({lateFeePct:2,interestMonthlyPct:1,conditionsText:''});
export const DEFAULT_SETTINGS = Object.freeze({
  lateFeeEnabled:true,lateFeePct:2,interestMonthlyPct:1,toleranceDays:0,
  earlyDiscountEnabled:false,earlyDiscountType:'percent',earlyDiscountValue:0,
  earlyMinDaysBefore:0,earlyStartsAt:null,earlyEndsAt:null,earlyPlanKeys:[],
  defaultDiscountDays:0,minChargeCents:100,shortCycleDays:0,
});
const fmt = new Intl.DateTimeFormat('en-US',{timeZone:PRICING_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function localParts(input) {
  const date=new Date(input);
  if(!Number.isFinite(date.getTime()))throw new RangeError('Data inválida.');
  const v=Object.fromEntries(fmt.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  return {year:v.year,month:v.month,day:v.day,hour:v.hour,minute:v.minute,second:v.second};
}
const dayNumber = p => Math.floor(Date.UTC(p.year,p.month-1,p.day)/86400000);
export const localDate = v => {const p=localParts(v);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`};
export function localDayDifference(a,b){return dayNumber(localParts(b))-dayNumber(localParts(a));}
// Converte meia-noite local com offset real do fuso (sem depender do fuso do processo Node).
export function endOfLocalDay(now){
  const p=localParts(now);const intended=Date.UTC(p.year,p.month-1,p.day,23,59,59);
  let instant=intended;
  for(let i=0;i<3;i++){
    const z=localParts(instant);
    const observed=Date.UTC(z.year,z.month-1,z.day,z.hour,z.minute,z.second);
    instant += intended-observed;
  }
  return new Date(instant);
}
export function pixExpiry(now,defaultMinutes=60){
  if(!Number.isInteger(defaultMinutes)||defaultMinutes<1)throw new RangeError('Prazo inválido.');
  return new Date(Math.min(new Date(now).getTime()+defaultMinutes*60000,endOfLocalDay(now).getTime()));
}
function cents(n,label='centavos'){
  if(!Number.isSafeInteger(Number(n))||Number(n)<0)throw new RangeError(`${label} deve ser inteiro não negativo.`);
  return Number(n);
}
function percentBp(value,label){
  const s=String(value??0);
  if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(s))throw new RangeError(`${label} inválido.`);
  const [whole,frac='']=s.split('.');const n=Number(whole)*100+Number(frac.padEnd(2,'0'));
  if(n>10000)throw new RangeError(`${label} inválido.`);
  return n;
}
function halfUp(n,d){return Number((BigInt(n)+BigInt(d)/2n)/BigInt(d));}
const pct=(n,bps)=>halfUp(BigInt(n)*BigInt(bps),10000);
export function validateSettings(settings={},caps=DEFAULT_CAPS){
  const s={...DEFAULT_SETTINGS,...settings};
  if(percentBp(s.lateFeePct,'multa')>percentBp(caps.lateFeePct,'teto de multa') ||
     percentBp(s.interestMonthlyPct,'juros')>percentBp(caps.interestMonthlyPct,'teto de juros'))
    throw new RangeError('Multa ou juros acima do teto da plataforma.');
  if(!Number.isInteger(s.toleranceDays)||s.toleranceDays<0||s.toleranceDays>10)throw new RangeError('Tolerância deve estar entre 0 e 10 dias.');
  if(!Number.isInteger(s.earlyMinDaysBefore)||s.earlyMinDaysBefore<0||s.earlyMinDaysBefore>3660)throw new RangeError('Antecedência inválida.');
  if(!['percent','fixed_cents'].includes(s.earlyDiscountType))throw new RangeError('Tipo de desconto antecipado inválido.');
  if(s.earlyDiscountType==='percent')percentBp(s.earlyDiscountValue,'desconto antecipado');
  else cents(s.earlyDiscountValue,'desconto antecipado');
  if(!Array.isArray(s.earlyPlanKeys)||s.earlyPlanKeys.length>200||s.earlyPlanKeys.some(x=>typeof x!=='string'||x.length>32))throw new RangeError('Planos inválidos.');
  if(!Number.isInteger(s.defaultDiscountDays)||s.defaultDiscountDays<0||s.defaultDiscountDays>3660)throw new RangeError('Dias de desconto inválidos.');
  if(!Number.isInteger(s.shortCycleDays)||s.shortCycleDays<0||s.shortCycleDays>3660)throw new RangeError('Ciclo curto inválido.');
  if(cents(s.minChargeCents,'cobrança mínima')<1)throw new RangeError('Cobrança mínima deve ser positiva.');
  if(s.earlyStartsAt&&s.earlyEndsAt&&new Date(s.earlyStartsAt)>new Date(s.earlyEndsAt))throw new RangeError('Agenda de desconto inválida.');
  return s;
}
/** Base proporcional de upgrade: diferença entre preços × dias restantes/validade, ou plano novo cheio após expirar. */
export function upgradeBaseCents({oldPriceCents,newPriceCents,validityDays,endsAt,now}){
  const old=cents(oldPriceCents),next=cents(newPriceCents);
  if(!Number.isInteger(validityDays)||validityDays<1)throw new RangeError('Validade inválida.');
  if(!endsAt||new Date(endsAt)<=new Date(now))return next;
  const remaining=Math.min(validityDays,Math.max(0,localDayDifference(now,endsAt)));
  return halfUp(BigInt(Math.max(0,next-old))*BigInt(remaining),validityDays);
}
/** Entradas: somente dados do servidor (plano, contrato, configurações e descontos autorizados). */
export function calculateChargePricing({kind='renewal',planPriceCents,oldPlanPriceCents=0,validityDays=30,
  endsAt=null,effectiveStatus=null,planKey='',now=new Date(),settings={},caps=DEFAULT_CAPS,manual=null,waiver=null}){
  const s=validateSettings(settings,caps),date=new Date(now),planPrice=cents(planPriceCents),oldPrice=cents(oldPlanPriceCents);
  if(!Number.isInteger(validityDays)||validityDays<1)throw new RangeError('Validade inválida.');
  if(!['renewal','upgrade'].includes(kind))throw new RangeError('Operação inválida.');
  const overdue=Boolean(endsAt&&new Date(endsAt)<=date&&effectiveStatus==='expired');
  const daysLate=overdue?Math.max(0,localDayDifference(endsAt,date)):0;
  const feeBase=overdue&&oldPrice>0?oldPrice:planPrice;
  const base=kind==='upgrade'?upgradeBaseCents({oldPriceCents:oldPrice,newPriceCents:planPrice,validityDays,endsAt:overdue?null:endsAt,now:date}):planPrice;
  if(base<1)throw new RangeError('Plano sem valor cobrável.');
  const minimum=s.minChargeCents;
  const earlyAllowed=kind==='renewal'&&!overdue&&Boolean(endsAt)&&s.earlyDiscountEnabled&&
    localDayDifference(date,endsAt)>=s.earlyMinDaysBefore&&date<=new Date(endsAt)&&
    (!s.earlyStartsAt||date>=new Date(s.earlyStartsAt))&&(!s.earlyEndsAt||date<=new Date(s.earlyEndsAt))&&
    (!s.earlyPlanKeys.length||s.earlyPlanKeys.includes(planKey));
  const early=earlyAllowed ? Math.min(Math.max(0,base-minimum),
    s.earlyDiscountType==='percent'?pct(base,percentBp(s.earlyDiscountValue,'desconto')):cents(s.earlyDiscountValue)):0;
  let manualAmount=0,manualMeta=null;
  if(manual){
    if(!['days','percent'].includes(manual.type))throw new RangeError('Desconto manual inválido.');
    const value=Number(manual.value);
    if(manual.type==='days'){
      if(!Number.isInteger(value)||value<1||value>=validityDays)throw new RangeError('Dias de desconto fora da validade.');
      manualAmount=halfUp(BigInt(base)*BigInt(value),validityDays);
    } else {
      const bps=percentBp(manual.value,'desconto manual');if(bps<100)throw new RangeError('Desconto mínimo de 1%.');
      manualAmount=pct(base,bps);
    }
    manualMeta={type:manual.type,value:manual.value,actorId:manual.actorId||null,reason:manual.reason||null,stack:Boolean(manual.stack)};
  }
  const eligible=Math.max(0,base-minimum);
  // Sem acumular, SOMENTE o maior benefício aparece na conta.
  const discount=manualMeta&&!manualMeta.stack?Math.min(eligible,Math.max(early,manualAmount)):Math.min(eligible,early+manualAmount);
  const appliedEarly=manualMeta&&!manualMeta.stack&&manualAmount>=early?0:Math.min(early,discount);
  const appliedManual=discount-appliedEarly;
  const lateFee=overdue&&daysLate>s.toleranceDays&&s.lateFeeEnabled?pct(feeBase,percentBp(s.lateFeePct,'multa')):0;
  const interest=overdue&&daysLate>s.toleranceDays&&s.lateFeeEnabled?
    halfUp(BigInt(feeBase)*BigInt(percentBp(s.interestMonthlyPct,'juros'))*BigInt(daysLate),300000):0;
  let waivedFee=0,waivedInterest=0,waiverMeta=null;
  if(waiver){
    if(!overdue||!String(waiver.reason||'').trim())throw new RangeError('Abono exige atraso e motivo.');
    waivedFee=waiver.full?lateFee:cents(waiver.lateFeeCents||0);
    waivedInterest=waiver.full?interest:cents(waiver.interestCents||0);
    if(waivedFee>lateFee||waivedInterest>interest)throw new RangeError('Abono excede encargos.');
    waiverMeta={actorId:waiver.actorId||null,reason:waiver.reason,full:Boolean(waiver.full)};
  }
  const total=Math.max(minimum,base-discount+lateFee+interest-waivedFee-waivedInterest);
  return Object.freeze({version:1,zone:PRICING_ZONE,kind,planKey,contractEndsAt:endsAt?new Date(endsAt).toISOString():null,
    fullPlanPriceCents:planPrice,oldPlanPriceCents:oldPrice,pricingSettings:{...s},baseCents:base,lateBaseCents:feeBase,
    earlyDiscountCents:appliedEarly,manualDiscountCents:appliedManual,manual:manualMeta,
    lateFeeCents:lateFee,interestCents:interest,daysLate,toleranceDays:s.toleranceDays,
    lateFeePct:s.lateFeeEnabled?s.lateFeePct:0,interestMonthlyPct:s.lateFeeEnabled?s.interestMonthlyPct:0,
    waiverFeeCents:waivedFee,waiverInterestCents:waivedInterest,waiver:waiverMeta,
    minChargeCents:minimum,totalCents:total,validityDays,chargedAt:date.toISOString()});
}

/** Montante exigível para pagamentos recebidos DEPOIS de expirar o QR.
 * Reusa exclusivamente a política congelada no snapshot, nunca as regras editadas posteriormente.
 */
export function requiredSettlementCents(snapshot,now=new Date(),fallbackAmount=null){
  if(!snapshot?.pricingSettings||!snapshot.contractEndsAt)return snapshot?.totalCents??fallbackAmount;
  const expired=new Date(snapshot.contractEndsAt)<new Date(now);
  return calculateChargePricing({kind:snapshot.kind,planPriceCents:snapshot.fullPlanPriceCents,
    oldPlanPriceCents:snapshot.oldPlanPriceCents,validityDays:snapshot.validityDays,
    planKey:snapshot.planKey,endsAt:snapshot.contractEndsAt,effectiveStatus:expired?'expired':'active',
    settings:snapshot.pricingSettings,caps:{lateFeePct:100,interestMonthlyPct:100},
    manual:snapshot.manual,waiver:snapshot.waiver?{
      ...snapshot.waiver,lateFeeCents:snapshot.waiverFeeCents,interestCents:snapshot.waiverInterestCents,
      reason:snapshot.waiver.reason,
    }:null,now}).totalCents;
}

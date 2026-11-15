/** Regras monetárias para a venda do PAINEL DO PARCEIRO (não licenças de TV). */
export const isContentPartner = kind => kind === 'content' || kind === 'both';
export function safeTotal(unitCents, quantity) {
  if (!Number.isSafeInteger(unitCents) || unitCents < 0 || !Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError('Valores inválidos');
  const total = BigInt(unitCents) * BigInt(quantity);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Total fora do intervalo');
  return Number(total);
}
export function resaleAllowed(price, plan, {exception = false} = {}) {
  if (!Number.isSafeInteger(price) || price < 0) return false;
  return exception || price >= Number(plan.min_resale_cents);
}
export function addMonthsUtc(date, months) {
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new RangeError('Meses inválidos');
  const base = new Date(date);
  if (!Number.isFinite(base.getTime())) throw new RangeError('Data inválida');
  const y = base.getUTCFullYear(), m = base.getUTCMonth(), day = base.getUTCDate();
  const first = new Date(Date.UTC(y, m + months, 1, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds()));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first;
}
export function allowedChildRole(parentId) { return parentId ? 'submaster' : 'master'; }

export function forecastMonthlyCost(input, activePartners) {
  const positive=(x)=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<0)throw new RangeError('Custo fora do intervalo');return n;};
  const partners=Math.max(1,positive(activePartners));
  const monthlyFixed=positive(input.vps_monthly_cents)+positive(input.domain_annual_cents)/12+positive(input.other_monthly_cents);
  const proxyPerPartner=positive(input.proxy_cost_per_gb_cents)*positive(input.forecast_proxy_gb_per_partner);
  const perPartner=monthlyFixed/partners+proxyPerPartner;
  const reserve=positive(input.reserve_bp)/10000, margin=positive(input.target_margin_bp)/10000,tax=positive(input.tax_bp)/10000;
  if(margin+tax>=0.9)throw new RangeError('Margem e tributos altos demais');
  const suggested=Math.ceil(perPartner*(1+reserve)/(1-margin-tax));
  if(!Number.isSafeInteger(suggested))throw new RangeError('Preço sugerido fora do intervalo');
  return {activePartners,monthlyFixedCents:Math.round(monthlyFixed),forecastProxyCents:Math.round(proxyPerPartner*partners),estimatedCostPerPartnerCents:Math.ceil(perPartner),suggestedWholesaleCents:suggested,
    caveat:'Estimativa, não apuração de lucro. Não incorpora consumo real de proxy, impostos ou taxas não informados.'};
}

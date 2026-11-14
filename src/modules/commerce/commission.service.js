import { QueryTypes } from 'sequelize';
import { sequelize, Partner } from '../../db/models/index.js';
import { audit } from '../../shared/audit.js';
import { AppError, notFound } from '../../shared/errors.js';
import { creditMove } from '../credits/credit-ledger.js';
import { commissionCredits } from './commerce.policy.js';

const select=(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,transaction,type:QueryTypes.SELECT});
const invalid=(message)=>new AppError(409,'COMMISSION_POLICY',message);
const ancestors=async(sellerId,t)=>select(`WITH RECURSIVE chain AS (
  SELECT id,parent_partner_id,status,ARRAY[id] AS visited FROM partners WHERE id=:sellerId
  UNION ALL SELECT p.id,p.parent_partner_id,p.status,c.visited||p.id
    FROM partners p JOIN chain c ON c.parent_partner_id=p.id WHERE NOT(p.id=ANY(c.visited))
) SELECT id,parent_partner_id,status FROM chain`,{sellerId},t);
export async function currentConfig(transaction){
  const row=(await select('SELECT max_total_bps AS "maxTotalBps" FROM commerce_commission_config WHERE id=1',{},transaction))[0];
  return row??{maxTotalBps:0};
}
export async function listRules(sellerId){
  return select(`SELECT seller_partner_id AS "sellerPartnerId",beneficiary_partner_id AS "beneficiaryPartnerId",
    basis_points AS "basisPoints",active FROM commerce_commission_rules WHERE seller_partner_id=:sellerId ORDER BY created_at`,{sellerId});
}
export async function listBeneficiaryCommissions(beneficiaryId){
  return select(`SELECT ce.id,ce.sale_id AS "saleId",ce.seller_partner_id AS "sellerPartnerId",
    ce.credits,ce.basis_points AS "basisPoints",ce.status,ce.created_at AS "createdAt"
    FROM commerce_commission_entries ce WHERE ce.beneficiary_partner_id=:beneficiaryId
    ORDER BY ce.created_at DESC LIMIT 100`,{beneficiaryId});
}
export async function setGlobalCap(maxTotalBps,actor){
  return sequelize.transaction(async t=>{
    await select('SELECT id FROM commerce_commission_config WHERE id=1 FOR UPDATE',{},t);
    const maxima=(await select(`SELECT COALESCE(max(total),0)::int AS total FROM (
      SELECT SUM(basis_points)::int AS total FROM commerce_commission_rules WHERE active=true GROUP BY seller_partner_id
    ) x`,{},t))[0];
    if(Number(maxima.total)>maxTotalBps) throw invalid('Reduza primeiro os percentuais existentes antes de baixar o teto global.');
    await select('UPDATE commerce_commission_config SET max_total_bps=:maxTotalBps,updated_at=now() WHERE id=1 RETURNING id',{maxTotalBps},t);
    await audit({actor,action:'commerce.commission.cap',entityType:'commerce_commission_config',entityId:null,
      metadata:{maxTotalBps},transaction:t});
    return {maxTotalBps};
  });
}
export async function setRule(sellerId,beneficiaryId,basisPoints,actor,{admin=false}={}){
  if(sellerId===beneficiaryId) throw invalid('Uma conta não pode comissionar a si própria.');
  return sequelize.transaction(async t=>{
    // Serialized policy changes. Readers see only committed configurations.
    await select('SELECT id FROM commerce_commission_config WHERE id=1 FOR UPDATE',{},t);
    const chain=await ancestors(sellerId,t);
    const beneficiary=chain.slice(1).find(p=>String(p.id)===String(beneficiaryId));
    if(!beneficiary) throw invalid('A conta beneficiária precisa ser superior à revenda vendedora.');
    if(!admin){
      const seller=await Partner.findByPk(sellerId,{transaction:t});
      const parent=await Partner.findByPk(beneficiaryId,{transaction:t});
      if(seller?.parentPartnerId!==beneficiaryId || parent?.distributionRole!=='master' ||
         parent?.status!=='active' || String(actor.partnerId)!==String(beneficiaryId))
        throw new AppError(403,'FORBIDDEN','Só o Master autorizado configura a comissão de seus revendedores diretos.');
      const policy=(await select('SELECT can_sell FROM reseller_network_policies WHERE partner_id=:id',{id:beneficiaryId},t))[0];
      if(!policy?.can_sell) throw new AppError(403,'FORBIDDEN','Sua conta não possui autorização para vendas.');
    }
    const maxTotalBps=(await currentConfig(t)).maxTotalBps;
    const others=(await select(`SELECT COALESCE(SUM(basis_points),0)::int AS sum FROM commerce_commission_rules
      WHERE seller_partner_id=:sellerId AND beneficiary_partner_id<>:beneficiaryId AND active=true`,{sellerId,beneficiaryId},t))[0].sum;
    if(Number(others)+basisPoints>maxTotalBps) throw invalid('A soma das comissões ultrapassa o teto configurado pelo Superadmin.');
    const row=(await select(`INSERT INTO commerce_commission_rules(seller_partner_id,beneficiary_partner_id,basis_points,active)
      VALUES(:sellerId,:beneficiaryId,:basisPoints,:active)
      ON CONFLICT(seller_partner_id,beneficiary_partner_id)
      DO UPDATE SET basis_points=EXCLUDED.basis_points,active=EXCLUDED.active,updated_at=now()
      RETURNING seller_partner_id AS "sellerPartnerId",beneficiary_partner_id AS "beneficiaryPartnerId",basis_points AS "basisPoints",active`,
      {sellerId,beneficiaryId,basisPoints,active:basisPoints>0},t))[0];
    await audit({actor,action:'commerce.commission.rule',entityType:'partner',entityId:sellerId,metadata:{beneficiaryId,basisPoints},transaction:t});
    return row;
  });
}
/** A compra via créditos já foi contabilizada. Reparte uma FRAÇÃO do recebimento do vendedor dentro da MESMA transação.
 * Nunca cria créditos sem origem: débito do vendedor = créditos recebidos pelos superiores.
 * Pix é outro domínio e não entra aqui até existir conversão e conciliação explicitamente configuradas.
 */
export async function settleNetworkCommissions({saleId,sellerId,totalCredits,transaction,actor}){
  const cap=(await currentConfig(transaction)).maxTotalBps;
  if(cap===0) return [];
  const hierarchy=await ancestors(sellerId,transaction);
  const ancestorsAllowed=new Set(hierarchy.slice(1).filter(x=>x.status==='active').map(x=>String(x.id)));
  const rules=(await listRulesInternal(sellerId,transaction))
    .filter(r=>r.active && ancestorsAllowed.has(String(r.beneficiary_partner_id)));
  const aggregate=rules.reduce((sum,r)=>sum+Number(r.basis_points),0);
  if(aggregate>cap) throw invalid('Política de comissão ultrapassa o teto global.');
  const entries=[];
  for(const rule of rules.sort((a,b)=>String(a.beneficiary_partner_id).localeCompare(String(b.beneficiary_partner_id)))){
    const credits=commissionCredits(totalCredits,Number(rule.basis_points));
    if(!credits) continue;
    const entry=(await select(`INSERT INTO commerce_commission_entries(sale_id,seller_partner_id,beneficiary_partner_id,basis_points,credits)
      VALUES(:saleId,:sellerId,:beneficiaryId,:bps,:credits)
      ON CONFLICT(sale_id,beneficiary_partner_id) DO NOTHING RETURNING id`,
      {saleId,sellerId,beneficiaryId:rule.beneficiary_partner_id,bps:rule.basis_points,credits},transaction))[0];
    if(!entry) continue;
    const note=`Comissão de venda da rede ${saleId}`;
    await creditMove(transaction,{partnerId:sellerId,delta:-credits,kind:'commission_debit',note,actor});
    await creditMove(transaction,{partnerId:rule.beneficiary_partner_id,delta:credits,kind:'commission_credit',note,actor});
    await audit({actor,action:'commerce.commission.settled',entityType:'reseller_network_sale',entityId:saleId,
      metadata:{sellerId,beneficiaryId:rule.beneficiary_partner_id,credits,basisPoints:rule.basis_points},transaction});
    entries.push({beneficiaryId:rule.beneficiary_partner_id,credits});
  }
  return entries;
}
const listRulesInternal=(sellerId,t)=>select('SELECT * FROM commerce_commission_rules WHERE seller_partner_id=:sellerId AND active=true',{sellerId},t);

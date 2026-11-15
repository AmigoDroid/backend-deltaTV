/** Exclusão operacional segura de códigos e servidores. Não apaga dados fiscais nem licenças.
 * A identidade e o parceiro dono são SEMPRE verificados no backend.
 */
import { Op, QueryTypes } from 'sequelize';
import { sequelize, Partner, PartnerCode, PartnerProvider, CodeServerPool, Activation, CodeFailover } from '../../db/models/index.js';
import { AppError, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { invalidateServerPools } from '../provider-monitor/code-pool.service.js';
import { clearResolutionCache } from '../provider-monitor/resolve.service.js';
import { invalidateQualityCache } from '../provider-monitor/quality.service.js';
import { clearContractAccessCache } from '../access/access.service.js';
import {exactConfirmation,requiresReplacementOrExplicitRisk} from './deletion.policy.js';

const checkConfirmation = (input, expected) => {
  if (!exactConfirmation(input?.confirmation, expected)) {
    throw new AppError(422,'CONFIRMATION_MISMATCH',`Para excluir, digite exatamente: ${expected}`);
  }
};
const active = { [Op.ne]: 'revoked' };
const notDeleted = { deletedAt: null };

export async function codeDeletionPreview(partnerId, codeId, {transaction}={}) {
  const c = await PartnerCode.findOne({where:{id:codeId,partnerId,...notDeleted},transaction});
  if(!c) throw notFound('Código');
  const [activations, liveActivations, pools, financial] = await Promise.all([
    Activation.count({where:{partnerCodeId:codeId},transaction}),
    Activation.count({where:{partnerCodeId:codeId,status:active},transaction}),
    CodeServerPool.count({where:{codeId},transaction}),
    sequelize.query(`SELECT
      (SELECT count(*)::int FROM content_activation_charges WHERE code_id = :codeId) AS charges,
      (SELECT COALESCE(allocated,0)::int FROM content_code_balances WHERE code_id = :codeId) AS allocated,
      (SELECT COALESCE(allocated-spent,0)::int FROM content_code_balances WHERE code_id = :codeId) AS available`,
      {replacements:{codeId},transaction,type:QueryTypes.SELECT}).then(rows=>rows[0]),
  ]);
  return { id:c.id,code:c.code,status:c.status,activations,liveActivations,pools,
    financialCharges:Number(financial?.charges||0),allocatedCredits:Number(financial?.allocated||0),availableCredits:Number(financial?.available||0),
    mode:'archive',warning:[liveActivations>0 ? 'Novas ativações serão impedidas. TVs existentes conservam suas licenças, mas recursos que exijam o código podem precisar de reconfiguração.' : null, Number(financial?.available||0)>0 ? 'Este código tem créditos disponíveis: eles ficarão preservados no histórico, porém indisponíveis até a recuperação administrativa do código.' : null].filter(Boolean).join(' ') || null };
}

export async function deleteCodeOperational(partnerId, codeId, input, actor) {
  const result=await sequelize.transaction(async transaction=>{
    // Ordem estável de bloqueio para evitar a concorrência com cadastro/ativação.
    const owner=await Partner.findByPk(partnerId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!owner)throw notFound('Parceria');
    const code=await PartnerCode.findOne({where:{id:codeId,partnerId,...notDeleted},transaction,lock:transaction.LOCK.UPDATE});
    if(!code)throw notFound('Código');
    checkConfirmation(input,code.code);
    const count=await Activation.count({where:{partnerCodeId:codeId,status:active},transaction});
    await code.update({status:'revoked',deletedAt:new Date()},{transaction});
    // Pools servem apenas para distribuição operacional. Apagar vínculos do código arquivado
    // libera os servidores sem alterar as ativações anteriores.
    const poolsRemoved=await CodeServerPool.destroy({where:{codeId},transaction});
    await audit({actor,action:'partner.code.delete_operational',entityType:'partner_code',entityId:code.id,
      metadata:{partnerId,code:code.code,liveActivations:count,poolsRemoved,reason:String(input.reason||'').slice(0,400),historyPreserved:true},transaction});
    return {deleted:true,mode:'archived',id:code.id,liveActivations:count,poolsRemoved};
  });
  invalidateServerPools(codeId);
  clearContractAccessCache();
  return result;
}

export async function providerDeletionPreview(partnerId, providerId, {transaction}={}) {
  const provider=await PartnerProvider.findOne({where:{id:providerId,partnerId,...notDeleted},transaction});
  if(!provider) throw notFound('Servidor');
  const [liveActivations,allActivations,codes,pools,alternatives] = await Promise.all([
    Activation.count({where:{providerId,status:active},transaction}),
    Activation.count({where:{providerId},transaction}),
    PartnerCode.count({where:{providerId,...notDeleted},transaction}),
    CodeServerPool.count({where:{providerId},transaction}),
    PartnerProvider.findAll({where:{partnerId,id:{[Op.ne]:providerId},status:'active',...notDeleted},attributes:['id','name'],order:[['priority','ASC']],transaction,raw:true}),
  ]);
  return {id:provider.id,name:provider.name,liveActivations,allActivations,codes,pools,alternatives,
    replacementRecommended:liveActivations>0||codes>0||pools>0,
    warning:liveActivations>0 ? 'Há TVs em uso. Se não escolher outro servidor, elas podem perder acesso ao conteúdo.' : null};
}

export async function deleteProviderOperational(partnerId, providerId, input, actor) {
  const result=await sequelize.transaction(async transaction=>{
    const owner=await Partner.findByPk(partnerId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!owner)throw notFound('Parceria');
    const provider=await PartnerProvider.findOne({where:{id:providerId,partnerId,...notDeleted},transaction,lock:transaction.LOCK.UPDATE});
    if(!provider)throw notFound('Servidor');
    checkConfirmation(input,provider.name);
    const preview=await providerDeletionPreview(partnerId,providerId,{transaction});
    const requestedReplacement=input?.replacementProviderId||null;
    let replacement=null;
    if(requestedReplacement){
      if(requestedReplacement===providerId)throw new AppError(422,'REPLACEMENT_INVALID','O servidor substituto deve ser diferente do excluído.');
      replacement=await PartnerProvider.findOne({where:{id:requestedReplacement,partnerId,status:'active',...notDeleted},transaction,lock:transaction.LOCK.UPDATE});
      if(!replacement)throw new AppError(422,'REPLACEMENT_INVALID','Servidor substituto indisponível ou de outra parceria.');
    }
    if(requiresReplacementOrExplicitRisk(preview.liveActivations,replacement?.id,input?.force)){
      throw new AppError(409,'PROVIDER_REPLACEMENT_REQUIRED','Escolha outro servidor para as TVs ativas ou confirme explicitamente a exclusão sem substituto.');
    }
    // Remover o servidor de TODOS os pools antes de arquivá-lo, eliminando o FK RESTRICT.
    const linked=await CodeServerPool.findAll({where:{providerId},attributes:['codeId'],transaction,raw:true});
    const affectedCodeIds=[...new Set(linked.map(x=>x.codeId))];
    if(affectedCodeIds.length){
      // Uma corrupção antiga do pool não autoriza alterar códigos de outra parceria.
      const owned=await PartnerCode.count({where:{id:{[Op.in]:affectedCodeIds},partnerId},transaction});
      if(owned!==affectedCodeIds.length)throw new AppError(409,'INVALID_POOL_SCOPE','Há um vínculo de pool inconsistente entre parcerias. Requer correção administrativa.');
    }
    const poolsRemoved=await CodeServerPool.destroy({where:{providerId},transaction});
    const primary=await PartnerCode.findAll({where:{providerId,partnerId,...notDeleted},transaction,lock:transaction.LOCK.UPDATE});
    const codeIds=[...new Set([...primary.map(x=>x.id),...affectedCodeIds])];
    const alternatives=preview.alternatives;
    for(const code of primary){
      // Sem destino escolhido, preservar o restante do pool; caso não exista, usar
      // outro servidor ativo da mesma parceria. NULL aciona o fallback legado.
      const pool=await CodeServerPool.findOne({where:{codeId:code.id},attributes:['providerId'],transaction,raw:true});
      const next=replacement?.id||pool?.providerId||alternatives[0]?.id||null;
      await code.update({providerId:next},{transaction});
    }
    if(replacement){
      // Se o pool era explícito, manter o substituto no conjunto autorizado.
      for(const codeId of affectedCodeIds){
        await CodeServerPool.findOrCreate({where:{codeId,providerId:replacement.id},defaults:{codeId,providerId:replacement.id},transaction});
      }
    }
    await Activation.update({providerId:replacement?.id||null},{where:{providerId},transaction});
    await CodeFailover.update({originalProviderId:replacement?.id||null},{where:{originalProviderId:providerId},transaction});
    await CodeFailover.update({currentProviderId:replacement?.id||null},{where:{currentProviderId:providerId},transaction});
    await provider.update({status:'disabled',deletedAt:new Date()},{transaction});
    await audit({actor,action:'provider.delete_operational',entityType:'partner_provider',entityId:providerId,
      metadata:{partnerId,name:provider.name,replacementProviderId:replacement?.id||null,force:!!input?.force,
        liveActivations:preview.liveActivations,codes:preview.codes,poolsRemoved,affectedCodes:codeIds.length,
        reason:String(input?.reason||'').slice(0,400),historyPreserved:true},transaction});
    return {deleted:true,mode:'archived',id:provider.id,replacementProviderId:replacement?.id||null,
      migratedActivations:preview.allActivations,poolsRemoved,affectedCodes:codeIds.length};
  });
  invalidateServerPools();
  clearResolutionCache();
  invalidateQualityCache();
  return result;
}

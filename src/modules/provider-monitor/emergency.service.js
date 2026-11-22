/** Troca manual temporária: pool permanente + preferência expira, sem suspender failover. */
import { Op, QueryTypes } from 'sequelize';
import { Partner, PartnerCode, PartnerProvider, CodeServerPool, ProviderHealth, sequelize } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { normalizeBaseUrl } from '../providers/playlist-url.js';
import { createProvider } from '../providers/provider.service.js';
import { probeServer } from './monitor.service.js';
import { getServicePlan } from '../service-plans/plan.service.js';
import { invalidateServerPools } from './code-pool.service.js';
import { clearResolutionCache } from './resolve.service.js';
import { broadcastDeviceHint } from '../../realtime/device-channel.js';
import { probeCredentials } from '../providers/provider.service.js';
import { notifyExpiredDeviceDns } from './device-dns.service.js';
import { decryptSecret } from '../../shared/crypto.js';

const select = (sql,replacements={})=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT});
const DEFAULT_NOTICE='Atualizando servidor. A transmissão será retomada automaticamente.';
const unique = ids => [...new Set(ids)];

export async function emergencyChoices(partnerId, {page=1,search=''}={}) {
  const pageSize=100;
  const where={partnerId,deletedAt:null,status:'active'};
  if(search.trim()) where[Op.or]=[
    {code:{[Op.iLike]:`%${search.trim()}%`}},
    {label:{[Op.iLike]:`%${search.trim()}%`}},
  ];
  const [servers,totalCodes,codes] = await Promise.all([
    PartnerProvider.findAll({where:{partnerId,deletedAt:null},attributes:['id','name','baseUrl','status'],order:[['priority','ASC']],raw:true}),
    PartnerCode.count({where}),
    PartnerCode.findAll({where,attributes:['id','code','label'],order:[['createdAt','DESC'],['id','ASC']],limit:pageSize,offset:(page-1)*pageSize,raw:true}),
  ]);
  const active=codes.length?await select(`SELECT e.code_id AS "codeId",e.provider_id AS "providerId",e.expires_at AS "expiresAt"
    FROM code_dns_emergencies e JOIN partner_codes c ON c.id=e.code_id
    WHERE c.partner_id=:partnerId AND e.code_id IN (:codeIds) AND e.expires_at>now()
    ORDER BY e.expires_at ASC`,{partnerId,codeIds:codes.map(c=>c.id)}):[];
  const progress=active.length?await select(`SELECT a.partner_code_id AS "codeId",
    count(a.id)::int AS total,
    count(a.id) FILTER (WHERE route.provider_id=e.provider_id)::int AS updated
    FROM code_dns_emergencies e
    JOIN activations a ON a.partner_code_id=e.code_id AND a.status='active'
    LEFT JOIN device_provider_routes route ON route.activation_id=a.id
    WHERE e.code_id IN (:codeIds) AND e.expires_at>now()
    GROUP BY a.partner_code_id`,{codeIds:active.map(x=>x.codeId)}):[];
  return {servers,codes,active,progress,defaultMinutes:30,maxCodes:500,
    page,pageSize,totalCodes,hasMore:page*pageSize<totalCodes};
}
async function validateAccess(partnerId, codeIds) {
  if (!Array.isArray(codeIds) || !codeIds.length || codeIds.length>500 || unique(codeIds).length!==codeIds.length)
    throw new AppError(422,'EMERGENCY_CODE_LIMIT','Selecione de 1 a 500 códigos, sem repetições.');
  const codes=await PartnerCode.findAll({where:{id:{[Op.in]:codeIds},partnerId,deletedAt:null,status:'active'},raw:true});
  if (codes.length!==codeIds.length) throw new AppError(404,'CODE_NOT_IN_SCOPE','Um ou mais códigos não pertencem à sua rede.');
  // Troca manual é recurso padrão. autoFailover controla apenas a seleção automática.
  const plan=await getServicePlan(partnerId,{fresh:true});
  return {codes,plan};
}

async function verifyCredentialsForCodes(provider,codes) {
  // Verificação de uma amostra (máximo quatro códigos). Cada TV confirma sua própria
  // credencial ao trocar, evitando centenas de chamadas bloqueantes na emergência.
  const rows=await select(`SELECT DISTINCT ON (a.partner_code_id) a.partner_code_id AS "codeId",a.credentials_enc AS "credentialsEnc"
    FROM activations a WHERE a.partner_code_id IN (:codeIds) AND a.status='active'
      AND a.playlist_url_enc IS NULL AND a.credentials_enc IS NOT NULL
    ORDER BY a.partner_code_id,a.activated_at DESC`,{codeIds:codes.map(c=>c.id)});
  const outcomes=await Promise.all(rows.slice(0,4).map(async row=>{
    try {
      const creds=JSON.parse(decryptSecret(row.credentialsEnc));
      const result=await probeCredentials(provider,creds);
      return result.ok?null:row.codeId;
    }catch{return row.codeId;}
  }));
  const failures=outcomes.filter(Boolean);
  if(failures.length) throw new AppError(409,'DNS_CREDENTIALS_UNVERIFIED',
    `Não foi possível confirmar credenciais da amostra na nova DNS (${failures.length} falha(s)). Nenhuma TV foi alterada.`);
}

export async function launchEmergency(partnerId, input, actor, userId) {
  if(process.env.PROVIDER_MONITOR_ENABLED!=='true'||process.env.PROVIDER_SMART_RESOLVER==='false')
    throw new AppError(409,'FAILOVER_DISABLED','Habilite o monitor e o resolvedor automático antes de iniciar uma emergência.');
  const {codes,plan}=await validateAccess(partnerId,input.codeIds);
  let provider;
  let newServer=false;
  if(input.providerId) {
    provider=await PartnerProvider.findOne({where:{id:input.providerId,partnerId,deletedAt:null,status:'active'},raw:true});
    if(!provider)throw new AppError(404,'PROVIDER_NOT_IN_SCOPE','DNS não cadastrada nesta parceria.');
  } else {
    const origin=normalizeBaseUrl(input.baseUrl);
    const existing=await PartnerProvider.findOne({where:{partnerId,baseUrl:origin,deletedAt:null},raw:true});
    if(existing?.status==='active')provider=existing;
    else if(existing)throw new AppError(409,'PROVIDER_DISABLED','DNS existente está desativada. Ative-a primeiro.');
    else {
      // Teste antes do cadastro; 404/401 pode indicar transporte acessível, NÃO streaming funcional.
      const probe=await probeServer(origin);
      if(!probe.good)throw new AppError(409,'DNS_UNREACHABLE','Não foi possível alcançar a DNS. Nenhuma TV foi alterada.');
      provider={baseUrl:origin};
      newServer=true;
    }
  }
  if(!newServer){
    const probe=await probeServer(provider.baseUrl);
    if(!probe.good)throw new AppError(409,'DNS_UNREACHABLE','A DNS escolhida não responde no teste HTTP.');
  }
  // Validar uma amostra antes de criar o servidor e ANTES da primeira escrita.
  // As demais credenciais são confirmadas na resolução autenticada de cada TV.
  await verifyCredentialsForCodes(provider,codes);
  // Uma DNS existente anteriormente marcada down pode estar recuperada; o teste
  // HTTP acima e a amostra autenticada permitem retirar o estado antigo.
  // O monitor medirá a saúde de novo nas próximas rodadas.
  // Não remover DNS antigas nem alterar o limite de pool para forçar a troca.
  // Se o pool estiver cheio, a prioridade expirável será resolvida pelo código.
  const expiresAt=new Date(Date.now()+input.minutes*60_000);
  await sequelize.transaction(async transaction=>{
    const owner=await Partner.findByPk(partnerId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!owner)throw new AppError(404,'PARTNER_NOT_FOUND','Parceria indisponível.');
    const freshPlan=await getServicePlan(partnerId,{fresh:true});
    if(newServer) provider=await createProvider(partnerId,{name:input.name||new URL(provider.baseUrl).hostname,
      baseUrl:provider.baseUrl,status:'active',priority:0},actor,{transaction});
    const current=await PartnerCode.findAll({where:{id:{[Op.in]:codes.map(c=>c.id)},partnerId,status:'active',deletedAt:null},
      transaction,lock:transaction.LOCK.UPDATE,raw:true});
    if(current.length!==codes.length)throw new AppError(409,'CODE_CHANGED','Os códigos foram alterados. Confira novamente.');
    const allLinks=await CodeServerPool.findAll({where:{codeId:{[Op.in]:codes.map(c=>c.id)}},transaction,raw:true});
    const linksByCode=new Map();
    for(const link of allLinks){if(!linksByCode.has(link.codeId))linksByCode.set(link.codeId,new Set());linksByCode.get(link.codeId).add(link.providerId);}
    const additions=[];
    let temporaryOnly=0;
    for(const code of codes){
      const before=linksByCode.get(code.id)||new Set();
      if(before.has(provider.id))continue;
      // Sem vínculo explícito, código legado conserva seu comportamento anterior.
      // Com pool cheio, a DNS emergencial vale apenas durante o prazo.
      const currentCount=before.size || (code.providerId ? 1 : 0);
      const limit=freshPlan.features.maxServers===null?null:Math.max(1,freshPlan.features.maxServers);
      if(!code.providerId && !before.size || limit!==null && currentCount>=limit){
        temporaryOnly++;
        continue;
      }
      if(!before.size && code.providerId) additions.push({codeId:code.id,providerId:code.providerId});
      additions.push({codeId:code.id,providerId:provider.id});
    }
    if(additions.length)await CodeServerPool.bulkCreate(additions,{transaction,ignoreDuplicates:true});
    await sequelize.query(`INSERT INTO code_dns_emergencies
      (code_id,provider_id,expires_at,created_by,created_at,updated_at,notified_at)
      SELECT c.id,:providerId,:expiresAt,:userId,now(),now(),NULL FROM partner_codes c
      WHERE c.id IN (:codeIds) AND c.partner_id=:partnerId AND c.status='active' AND c.deleted_at IS NULL
      ON CONFLICT(code_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,expires_at=EXCLUDED.expires_at,
      created_by=EXCLUDED.created_by,updated_at=now(),notified_at=NULL`,
      {replacements:{providerId:provider.id,expiresAt,userId,codeIds:codes.map(c=>c.id),partnerId},transaction});
    await audit({actor,action:'dns.emergency.start',entityType:'partner',entityId:partnerId,
      metadata:{providerId:provider.id,codeIds:codes.map(c=>c.id),expiresAt:expiresAt.toISOString(),minutes:input.minutes,temporaryOnly},transaction});
  });
  // O estado de saúde só é invalidado após commit bem-sucedido.
  await ProviderHealth.update({state:'unknown',lastCheckedAt:null,failures:0,successes:0},
    {where:{providerId:provider.id,state:'down'}}).catch(err=>console.warn('[emergency-dns] health reset',err.message));
  invalidateServerPools();clearResolutionCache();
  // Enviar apenas IDs e mensagem, nunca a URL Xtream ou credenciais. A TV consulta a API autenticada.
  for(const code of codes)broadcastDeviceHint({topic:'dns-emergency',partnerId,codeId:code.id,
    expiresAt:expiresAt.toISOString(),message:input.notify?input.message||DEFAULT_NOTICE:null});
  return {ok:true,providerId:provider.id,created:newServer,expiresAt,codeCount:codes.length,
    noticeSent:!!input.notify,delivery:'wss-or-https',offline:'next-connection'};
}

export async function stopEmergency(partnerId,codeIds,actor) {
  await validateAccess(partnerId,codeIds);
  const rows=await select(`DELETE FROM code_dns_emergencies e USING partner_codes c
    WHERE e.code_id=c.id AND c.partner_id=:partnerId AND e.code_id IN (:codeIds)
    RETURNING e.code_id AS "codeId"`,{partnerId,codeIds});
  await audit({actor,action:'dns.emergency.stop',entityType:'partner',entityId:partnerId,metadata:{codeIds}});
  invalidateServerPools();clearResolutionCache();
  for(const code of rows)broadcastDeviceHint({topic:'dns-emergency-end',partnerId,codeId:code.codeId});
  return {ok:true,ended:rows.length};
}

/** Executado pelo monitor uma vez a cada ciclo. Não emite um evento por aparelho. */
export async function notifyExpiredEmergencies() {
  const rows=await select(`UPDATE code_dns_emergencies e SET notified_at=now()
    FROM partner_codes c WHERE e.code_id=c.id AND e.expires_at<=now() AND e.notified_at IS NULL
    RETURNING e.code_id AS "codeId",c.partner_id AS "partnerId"`);
  if (rows.length)clearResolutionCache();
  for(const item of rows)broadcastDeviceHint({topic:'dns-emergency-end',partnerId:item.partnerId,codeId:item.codeId});
  return rows.length + await notifyExpiredDeviceDns();
}

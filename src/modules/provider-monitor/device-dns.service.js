/** Preferência temporária de DNS de uma única TV. A pool do código nunca é alterada. */
import { QueryTypes } from 'sequelize';
import { Activation, PartnerCode, ProviderHealth, sequelize } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { decryptSecret } from '../../shared/crypto.js';
import { serversForCode } from './code-pool.service.js';
import { clearResolutionCache } from './resolve.service.js';
import { probeCredentials } from '../providers/provider.service.js';
import { probeServer } from './monitor.service.js';
import { selectedProviderForDevice } from './active-route.service.js';
import { broadcastDeviceHint } from '../../realtime/device-channel.js';

const query=(sql,replacements={})=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT});
const DEFAULT_MESSAGE='Atualizando servidor. A transmissão será retomada automaticamente.';

async function eligibleDevice(partnerId, activationId) {
  const a=await Activation.findOne({where:{id:activationId,partnerId,status:'active'},raw:true});
  if(!a)throw new AppError(404,'DEVICE_NOT_IN_SCOPE','TV não encontrada ou ativação não está ativa nesta parceria.');
  if(!a.partnerCodeId || a.playlistUrlEnc || !a.providerId || !a.credentialsEnc)
    throw new AppError(409,'DEVICE_DNS_NOT_SUPPORTED','Esta TV não utiliza uma lista Xtream associada a um código com DNS gerenciadas.');
  const code=await PartnerCode.findOne({where:{id:a.partnerCodeId,partnerId,status:'active',deletedAt:null},raw:true});
  if(!code)throw new AppError(409,'CODE_INACTIVE','O código desta TV não está ativo.');
  // Prioridade manual individual não depende da opção comercial de failover automático.
  const servers=await serversForCode(code,{bypassCache:true,emergency:true});
  if(!servers.length)throw new AppError(409,'EMPTY_SERVER_POOL','Nenhuma DNS permitida para este código.');
  return {activation:a,code,servers};
}

/** Pesquisa exata por MAC: não lista MACs de outras parcerias. */
export async function deviceDnsChoices(partnerId,mac) {
  const clean=String(mac||'').replace(/[^0-9a-f]/ig,'').toUpperCase();
  if(!/^[0-9A-F]{12}$/.test(clean))throw new AppError(422,'INVALID_MAC','Informe um MAC válido.');
  const canonical=clean.match(/.{2}/g).join(':');
  const activation=await Activation.findOne({where:{mac:canonical,partnerId,status:'active'},attributes:['id'],raw:true});
  if(!activation)throw new AppError(404,'DEVICE_NOT_IN_SCOPE','TV não encontrada nesta parceria.');
  const {activation:a,code,servers}=await eligibleDevice(partnerId,activation.id);
  const [saved]=await query(`SELECT provider_id AS "providerId",expires_at AS "expiresAt"
    FROM device_dns_overrides WHERE activation_id=:aid AND expires_at>now() LIMIT 1`,{aid:a.id});
  return {device:{id:a.id,mac:a.mac,codeId:code.id,code:code.code},
    servers:servers.map(s=>({id:s.id,name:s.name,baseUrl:s.baseUrl,status:s.status})),
    active:saved||null,selectedProviderId:await selectedProviderForDevice(a.id)};
}

export async function forceDeviceDns(partnerId,activationId,input,actor,userId){
  if(process.env.PROVIDER_MONITOR_ENABLED!=='true'||process.env.PROVIDER_SMART_RESOLVER==='false')
    throw new AppError(409,'FAILOVER_DISABLED','Monitor e resolvedor devem estar habilitados.');
  const {activation,servers}=await eligibleDevice(partnerId,activationId);
  const provider=servers.find(s=>s.id===input.providerId && s.status==='active');
  if(!provider)throw new AppError(422,'PROVIDER_NOT_IN_POOL','Escolha uma DNS autorizada pelo código desta TV.');
  const probe=await probeServer(provider.baseUrl);
  if(!probe.good)throw new AppError(409,'DNS_UNREACHABLE','A DNS escolhida não respondeu ao teste HTTP.');
  const state=await ProviderHealth.findOne({where:{providerId:provider.id},attributes:['state'],raw:true});
  if(state?.state==='down')throw new AppError(409,'DNS_MARKED_DOWN','A DNS segue marcada como indisponível no monitor.');
  let credentials;
  try { credentials=JSON.parse(decryptSecret(activation.credentialsEnc)); }
  catch { throw new AppError(409,'CREDENTIALS_UNAVAILABLE','As credenciais desta TV não estão disponíveis para validar a DNS.'); }
  const auth=await probeCredentials(provider,credentials);
  if(!auth.ok)throw new AppError(409,'DNS_CREDENTIALS_UNVERIFIED','Não foi possível autenticar esta TV na DNS escolhida.');
  const expiresAt=new Date(Date.now()+input.minutes*60000);
  // Revalida vínculo dentro da transação para não trocar DNS após desvinculação concorrente.
  await sequelize.transaction(async transaction=>{
    const a=await Activation.findOne({where:{id:activationId,partnerId,status:'active',partnerCodeId:activation.partnerCodeId},transaction,lock:transaction.LOCK.UPDATE});
    if(!a)throw new AppError(409,'ACTIVATION_CHANGED','A ativação mudou durante a operação.');
    await sequelize.query(`INSERT INTO device_dns_overrides
      (activation_id,provider_id,expires_at,created_by,created_at,updated_at,notified_at)
      VALUES (:aid,:providerId,:expiresAt,:userId,now(),now(),NULL)
      ON CONFLICT(activation_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,
        expires_at=EXCLUDED.expires_at,created_by=EXCLUDED.created_by,updated_at=now(),notified_at=NULL`,
      {replacements:{aid:activationId,providerId:provider.id,expiresAt,userId},transaction});
    await audit({actor,action:'dns.device.start',entityType:'activation',entityId:activationId,
      metadata:{providerId:provider.id,expiresAt:expiresAt.toISOString(),minutes:input.minutes},transaction});
  });
  clearResolutionCache();
  broadcastDeviceHint({topic:'dns-device',activationId,partnerId,
    expiresAt:expiresAt.toISOString(),message:input.notify?(input.message||DEFAULT_MESSAGE):null});
  return {ok:true,activationId,providerId:provider.id,expiresAt,delivery:'wss-or-https',offline:'next-connection'};
}

export async function endDeviceDns(partnerId,activationId,actor){
  await eligibleDevice(partnerId,activationId);
  const rows=await query(`DELETE FROM device_dns_overrides d USING activations a
    WHERE d.activation_id=a.id AND a.id=:aid AND a.partner_id=:partnerId RETURNING d.activation_id AS id`,
    {aid:activationId,partnerId});
  if(rows.length){
    await audit({actor,action:'dns.device.stop',entityType:'activation',entityId:activationId});
    clearResolutionCache();
    broadcastDeviceHint({topic:'dns-device-end',activationId,partnerId});
  }
  return {ok:true,ended:rows.length};
}

export async function notifyExpiredDeviceDns(){
  const rows=await query(`UPDATE device_dns_overrides d SET notified_at=now()
    FROM activations a WHERE d.activation_id=a.id AND d.expires_at<=now() AND d.notified_at IS NULL
    RETURNING d.activation_id AS "activationId",a.partner_id AS "partnerId"`);
  if(rows.length)clearResolutionCache();
  for(const row of rows)broadcastDeviceHint({topic:'dns-device-end',...row});
  return rows.length;
}

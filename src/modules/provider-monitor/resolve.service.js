import { rememberSelectedProvider } from "./active-route.service.js";
import { webActivationDefaults } from "../settings/platform-settings.service.js";
import { webProvider } from "../web/web-https.js";
import { xtreamApiUrl } from "./url-utils.js";
import { freshnessWindowSeconds } from "./visibility.service.js";
import { createHash } from "node:crypto";
import { PartnerCode, ProviderHealth } from "../../db/models/index.js";
import { sequelize } from "../../db/sequelize.js";
import { QueryTypes } from "sequelize";
import { safeGet } from "../../shared/ssrf.js";
import { serversForCode } from "./code-pool.service.js";
import {getServicePlan} from "../service-plans/plan.service.js";

// A seleção ocorre na abertura/atualização do catálogo, NUNCA em cada segmento de vídeo.
// Sem fila de espera: sob pico, usa o servidor original para manter latência da API baixa.
const enabled = () => process.env.PROVIDER_MONITOR_ENABLED === "true" && process.env.PROVIDER_SMART_RESOLVER !== "false";
const HEALTH_MS = 20_000, VERIFY_OK_MS = 600_000, VERIFY_BAD_MS = 30_000;
const MAX_CHECKS = 3500, MAX_HEALTH = 1000, MAX_SIMULTANEOUS = 6;
const validations = new Map(), healthCache = new Map();
const inFlight = new Map();
let verifying = 0;
const put = (m,k,v,limit) => {m.delete(k);m.set(k,v);if(m.size>limit)m.delete(m.keys().next().value);};
const keyOf = (p,username,password) => createHash("sha256").update(`${p.id}\0${p.baseUrl}\0${username}\0${password}`).digest("hex");
export function clearResolutionCache() { validations.clear(); healthCache.clear();}

async function statesOf(servers) {
  const ids = servers.map(s=>s.id);
  const key=ids.slice().sort().join(",");
  const hit=healthCache.get(key);
  if(hit && Date.now()-hit.at<HEALTH_MS)return hit.states;
  const rows=await ProviderHealth.findAll({where:{providerId:ids},attributes:["providerId","state","latencyMs","lastCheckedAt"],raw:true});
  const states=new Map(rows.map(r=>[r.providerId,r]));
  put(healthCache,key,{at:Date.now(),states},MAX_HEALTH);
  return states;
}

async function verifyAlternative(server, username, password) {
  const key=keyOf(server,username,password), now=Date.now();
  const old=validations.get(key);
  if(old && now-old.at < (old.ok?VERIFY_OK_MS:VERIFY_BAD_MS))return old.ok;
  if(inFlight.has(key))return inFlight.get(key);
  if(verifying>=MAX_SIMULTANEOUS)return false;
  verifying++;
  const pending=(async()=>{
    let res;
    try {
      const api = xtreamApiUrl(server.baseUrl);
      api.searchParams.set("username", username);
      api.searchParams.set("password", password);
      const url = api.toString();
      // Não seguir redirects: credenciais não devem ser encaminhadas para outro domínio.
      res=await safeGet(url,{maxRedirects:0,timeoutMs:1800,headers:{"user-agent":"DeltaTV-Resolver/1.0",accept:"application/json"}});
      if(res.statusCode!==200)return false;
      let size=0, chunks=[];
      for await(const chunk of res){size+=chunk.length;if(size>32*1024)return false;chunks.push(chunk);}
      const ui=JSON.parse(Buffer.concat(chunks).toString("utf8"))?.user_info;
      const ok=Number(ui?.auth)===1 && String(ui?.status??"Active").toLowerCase()==="active";
      put(validations,key,{at:Date.now(),ok},MAX_CHECKS);
      return ok;
    }catch{return false;}
    finally{res?.destroy();}
  })().finally(()=>{verifying--;inFlight.delete(key);});
  inFlight.set(key,pending);
  return pending;
}

/** Escolhe um servidor seguro para as credenciais de UMA ativação, sem mudar seu vínculo no banco. */
export async function resolveForActivation(activation, original, credentials) {
  activation = await webActivationDefaults(activation);
  original = webProvider(original, activation);
  if (!enabled() || !activation.partnerCodeId || !activation.partnerId || activation.playlistUrlEnc) return {provider:original, verified:false};
  try {
    const code=await PartnerCode.findByPk(activation.partnerCodeId,{attributes:["id","partnerId","providerId","status","expiresAt"]});
    if(!code || code.partnerId!==activation.partnerId || code.status!=="active" || (code.expiresAt && code.expiresAt<=new Date()))return {provider:original,verified:false};
    const plan=await getServicePlan(code.partnerId);
    if(!plan.features.autoFailover)return {provider:original,verified:false};
    const servers=(await serversForCode(code)).map(server => webProvider(server, activation));
    if(!servers.length)return {provider:original,verified:false};
    // Se o parceiro removeu explicitamente a origem antiga do pool, ela NÃO pode ser entregue novamente.
    const states=await statesOf(servers);
    // Não devolver uma origem sabidamente DOWN apenas por ser a original.
    const originalHealth=states.get(original?.id);
    const fallback={provider:servers.some(s=>s.id===original?.id) && originalHealth?.state!=="down"?original:null,verified:false};
    // Preferência temporária deste dispositivo após erro real de reprodução. Não
    // altera a saúde global do provedor nem as escolhas das outras TVs.
    const [request] = await sequelize.query(`SELECT avoid_provider_id FROM device_failover_requests
      WHERE activation_id=:aid AND expires_at>now() LIMIT 1`,
      { replacements:{aid:activation.id},type:QueryTypes.SELECT });
    const avoidId = request?.avoid_provider_id || null;
    // Preferência emergencial só durante o prazo e apenas para o código da TV.
    // Um erro reportado pela própria TV (avoidId) ou autenticação inválida permite
    // seguir para o failover automático, mesmo durante a emergência.
    // Uma consulta para as duas prioridades (sem adicionar outro round-trip ao PostgreSQL).
    const [preferences] = await sequelize.query(`SELECT
      (SELECT provider_id FROM device_dns_overrides WHERE activation_id=:aid AND expires_at>now()) AS "deviceProviderId",
      (SELECT provider_id FROM code_dns_emergencies WHERE code_id=:codeId AND expires_at>now()) AS "codeProviderId"`,
      {replacements:{aid:activation.id,codeId:code.id},type:QueryTypes.SELECT});
    // Precedência: override da ativação > emergência por código > seleção automática.
    // Não sobrepor erro relatado pelo aparelho ou DNS confirmada como down.
    const deviceForced=servers.find(s=>s.id===preferences?.deviceProviderId && s.status==='active');
    if(deviceForced && deviceForced.id!==avoidId && states.get(deviceForced.id)?.state!=='down' &&
      (deviceForced.id===original?.id || await verifyAlternative(deviceForced,credentials.username,credentials.password))) {
      await rememberSelectedProvider(activation.id,deviceForced.id).catch(()=>{});
      return {provider:deviceForced,verified:deviceForced.id!==original?.id};
    }
    const forced=servers.find(s=>s.id===preferences?.codeProviderId && s.status==='active');
    if(forced && forced.id!==avoidId && states.get(forced.id)?.state!=='down') {
      // A emergência foi autorizada pelo operador após sondagem + amostra Xtream.
      // Não executar 3.000 autenticações HTTP concorrentes na VPS: as TVs
      // validam o streaming, e um erro real registra avoidId para o failover.
      await rememberSelectedProvider(activation.id,forced.id).catch(()=>{});
      return {provider:forced,verified:true};
    }
    const now=Date.now();
    const freshMs = (await freshnessWindowSeconds()) * 1000;
    const ranked=servers.filter(s=>s.id!==avoidId && s.status==="active" && ["healthy", "slow"].includes(states.get(s.id)?.state)
      && now-new Date(states.get(s.id).lastCheckedAt).getTime()<freshMs)
      .sort((a,b)=>(states.get(a.id).state === "slow")-(states.get(b.id).state === "slow")
        || (states.get(a.id).latencyMs??99999)-(states.get(b.id).latencyMs??99999)
        || a.priority-b.priority);
    if(!ranked.length)return fallback;
    // Cada GET /client/xtream prioriza a menor latência saudável medida.
    // O cache de 60s do Roku evita requisições repetitivas; o "pin" de 120s
    // não pode sobrepor uma rota comprovadamente mais rápida na reconexão.
    const selected = ranked[0];
    if(selected.id===original?.id){
      await rememberSelectedProvider(activation.id, selected.id).catch(e=>console.warn("[smart-resolver] estado atual",e.message));
      return {provider:selected,verified:false};}
    // Tenta progressivamente alternativas saudáveis dentro do orçamento de latência.
    // Cada validação possui timeout individual; não bloquear o catálogo indefinidamente.
    const deadline = Date.now() + 5500;
    const candidates = [selected, ...ranked.filter(s => s.id !== selected.id && s.id !== original?.id)];
    for (const candidate of candidates.slice(0, 4)) {
      if (Date.now() >= deadline) break;
      if (await verifyAlternative(candidate, credentials.username, credentials.password)) {
        await rememberSelectedProvider(activation.id,candidate.id).catch(e=>console.warn("[smart-resolver] estado atual",e.message));
        return { provider: candidate, verified: true };
      }
    }
    return fallback;
  } catch(e) {
    console.warn("[smart-resolver] fallback seguro",e.message);
    return {provider:original,verified:false};
  }
}

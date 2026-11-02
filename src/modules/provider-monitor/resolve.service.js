import { selectHealthy } from "./ranking.js";
import { createHash } from "node:crypto";
import { PartnerCode, ProviderHealth } from "../../db/models/index.js";
import { safeGet } from "../../shared/ssrf.js";
import { serversForCode } from "./code-pool.service.js";
import {getServicePlan} from "../service-plans/plan.service.js";

// A seleção ocorre na abertura/atualização do catálogo, NUNCA em cada segmento de vídeo.
// Sem fila de espera: sob pico, usa o servidor original para manter latência da API baixa.
const enabled = () => process.env.PROVIDER_MONITOR_ENABLED === "true" && process.env.PROVIDER_SMART_RESOLVER !== "false";
const PIN_MS = 120_000, HEALTH_MS = 20_000, VERIFY_OK_MS = 600_000, VERIFY_BAD_MS = 30_000;
const MAX_PINS = 5000, MAX_CHECKS = 3500, MAX_HEALTH = 1000, MAX_SIMULTANEOUS = 6;
const pins = new Map(), validations = new Map(), healthCache = new Map();
const inFlight = new Map();
let verifying = 0;
const put = (m,k,v,limit) => {m.delete(k);m.set(k,v);if(m.size>limit)m.delete(m.keys().next().value);};
const keyOf = (p,username,password) => createHash("sha256").update(`${p.id}\0${p.baseUrl}\0${username}\0${password}`).digest("hex");
export function clearResolutionCache() {pins.clear(); validations.clear(); healthCache.clear();}

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
      const url=`${new URL(server.baseUrl).origin}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
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
  if (!enabled() || !activation.partnerCodeId || !activation.partnerId || activation.playlistUrlEnc) return {provider:original, verified:false};
  try {
    const code=await PartnerCode.findByPk(activation.partnerCodeId,{attributes:["id","partnerId","providerId","status","expiresAt"]});
    if(!code || code.partnerId!==activation.partnerId || code.status!=="active" || (code.expiresAt && code.expiresAt<=new Date()))return {provider:original,verified:false};
    const plan=await getServicePlan(code.partnerId);
    if(!plan.features.autoFailover)return {provider:original,verified:false};
    const servers=await serversForCode(code);
    if(!servers.length)return {provider:original,verified:false};
    // Se o parceiro removeu explicitamente a origem antiga do pool, ela NÃO pode ser entregue novamente.
    const fallback={provider:servers.some(s=>s.id===original?.id)?original:null,verified:false};
    const states=await statesOf(servers);
    const now=Date.now();
    const automatic=plan.features.autoPriority;
    const ranked=servers.filter(s=>s.status==="active" && states.get(s.id)?.state==="healthy"
      && now-new Date(states.get(s.id).lastCheckedAt).getTime()<180_000)
      .sort((a,b)=>automatic?(states.get(a.id).latencyMs??99999)-(states.get(b.id).latencyMs??99999) || a.priority-b.priority
        :a.priority-b.priority || (states.get(a.id).latencyMs??99999)-(states.get(b.id).latencyMs??99999));
    if(!ranked.length)return fallback;
    const pinned=pins.get(activation.id);
    // Para evitar flapping, só troca por ganho significativo (>=50 ms e >=15%).
    const scored=ranked.map(s=>({...s,latencyMs:states.get(s.id)?.latencyMs??99999}));
    const selected=automatic?selectHealthy(scored,pinned,now):(pinned?.until>now && scored.find(s=>s.id===pinned.providerId) || scored[0]);
    if(selected.id===original?.id){put(pins,activation.id,{providerId:selected.id,until:now+PIN_MS},MAX_PINS);return {provider:selected,verified:false};}
    // A URL alternativa DEVE aceitar o usuário/senha desta ativação. Se não, não há mudança.
    const compatible=await verifyAlternative(selected,credentials.username,credentials.password);
    if(compatible){put(pins,activation.id,{providerId:selected.id,until:now+PIN_MS},MAX_PINS);return {provider:selected,verified:true};}
    // Se a primeira alternativa não aceitar as credenciais, tente SOMENTE mais uma (sem cascata cara).
    const second=ranked.find(s=>s.id!==selected.id && s.id!==original?.id);
    if(second && await verifyAlternative(second,credentials.username,credentials.password)) {
      put(pins,activation.id,{providerId:second.id,until:now+PIN_MS},MAX_PINS);
      return {provider:second,verified:true};
    }
    return fallback;
  } catch(e) {
    console.warn("[smart-resolver] fallback seguro",e.message);
    return {provider:original,verified:false};
  }
}

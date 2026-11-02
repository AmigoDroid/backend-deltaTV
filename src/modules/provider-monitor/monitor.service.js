import http from "node:http";
import https from "node:https";
import { Op } from "sequelize";
import { Partner, PartnerCode, PartnerProvider, ProviderHealth, CodeFailover, sequelize } from "../../db/models/index.js";
import { assertPublicUrl, safeLookup } from "../../shared/ssrf.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import { sendMail } from "../mail/mail.transport.js";
import { env } from "../../config/env.js";
import { audit } from "../../shared/audit.js";

const INTERVAL = Math.max(30, Number(process.env.PROVIDER_MONITOR_INTERVAL_SECONDS || 60));
const TIMEOUT = Math.max(1000, Math.min(10000, Number(process.env.PROVIDER_MONITOR_TIMEOUT_MS || 4000)));
const SLOW = Math.max(500, Number(process.env.PROVIDER_MONITOR_SLOW_MS || 2500));
let timer, running = false;

// Do not follow redirects or download response bodies; verify DNS again at connect time.
export async function probeServer(raw) {
 const url = await assertPublicUrl(raw);
 const target = new URL("/player_api.php", url);
 const started = Date.now();
 return new Promise(resolve => {
  const transport = target.protocol === "https:" ? https : http;
  const req = transport.request(target, { method:"GET", lookup:safeLookup, timeout:TIMEOUT,
   headers:{ "User-Agent":"DeltaTV-Monitor/1.0", "Accept":"application/json", "Connection":"close" } }, res => {
    const ms = Date.now()-started;
    const good = res.statusCode >= 200 && res.statusCode < 500 && res.statusCode !== 429 && ms <= SLOW;
    res.destroy();
    resolve({ good, latencyMs:ms, error: good ? null : (ms>SLOW ? "Resposta lenta" : `HTTP ${res.statusCode}`) });
  });
  req.on("timeout", () => req.destroy(new Error("Timeout")));
  req.on("error", e => resolve({ good:false, latencyMs:Date.now()-started, error:String(e.message).slice(0,180) }));
  req.end();
 });
}

export async function monitorOnce() {
 if (running) return;
 running=true;
 try {
  const providers=await PartnerProvider.findAll({where:{status:"active"},order:[["partnerId","ASC"],["priority","ASC"]]});
  for (const provider of providers) {
   try {
    const r=await probeServer(provider.baseUrl);
    let h=await ProviderHealth.findOne({where:{providerId:provider.id}});
    if(!h) h=ProviderHealth.build({providerId:provider.id});
    const failures=r.good ? 0 : (h.failures||0)+1;
    const successes=r.good ? (h.successes||0)+1 : 0;
    const state=failures>=2 ? "down" : successes>=2 ? "healthy" : r.good ? "checking" : "suspect";
    await h.update({state,latencyMs:r.latencyMs,lastCheckedAt:new Date(),
      lastGoodAt:r.good?new Date():h.lastGoodAt,failures,successes,lastError:r.error});
   } catch(e) { console.warn("[provider-monitor]",provider.id,e.message); }
  }
  const liveProviders=providers.filter(p=>p.status==="active");
  const byPartner=new Map();
  for(const p of liveProviders){if(!byPartner.has(p.partnerId))byPartner.set(p.partnerId,[]);byPartner.get(p.partnerId).push(p);}
  const health=await ProviderHealth.findAll({where:{providerId:{[Op.in]:providers.map(x=>x.id)}}});
  const goodIds=new Set(health.filter(h=>h.state==="healthy").map(h=>h.providerId));
  const downIds=new Set(health.filter(h=>h.state==="down").map(h=>h.providerId));
  const codes=await PartnerCode.findAll({where:{status:"active",providerId:{[Op.ne]:null}}});
  for(const code of codes){
   const candidates=byPartner.get(code.partnerId)||[];
   if(!candidates.length)continue;
   const current=candidates.find(p=>p.id===code.providerId);
   const healthy=candidates.find(p=>goodIds.has(p.id));
   let state=await CodeFailover.findOne({where:{codeId:code.id}});
   if(!state)state=await CodeFailover.create({codeId:code.id,originalProviderId:code.providerId,currentProviderId:code.providerId});
   // Only fail over after TWO failed probes. Do not flip while status is unknown/suspect.
   if(current && downIds.has(current.id) && healthy && healthy.id!==current.id){
    await sequelize.transaction(async t=>{
      await code.update({providerId:healthy.id},{transaction:t});
      await state.update({currentProviderId:healthy.id,lastSwitchedAt:new Date(),outageNotifiedAt:null},{transaction:t});
      await audit({actor:{type:"system"},action:"provider.failover",entityType:"partner_code",entityId:code.id,
        metadata:{from:current.id,to:healthy.id},transaction:t});
    });
    clearMirrorAuth();
   }
   const allDown=candidates.every(p=>downIds.has(p.id));
   if(allDown && !state.outageNotifiedAt){
     // Persist before send to avoid e-mail storms; failed delivery is logged for manual retry.
     await state.update({outageNotifiedAt:new Date()});
     try {
       const partner=await Partner.findByPk(code.partnerId);
       if(partner?.contactEmail && env.mail.configured){
         await sendMail({to:partner.contactEmail,subject:`[Delta TV] Indisponibilidade do código ${code.code}`,
           text:`Todos os servidores ativos cadastrados para sua parceria estão indisponíveis. Código: ${code.code}. Verifique os endereços no painel parceiro.deltatv.com.br.`});
       }else console.warn("[provider-monitor] Sem SMTP ou e-mail para",code.id);
     }catch(e){console.error("[provider-monitor] E-mail",code.id,e.message);}
   }else if(healthy && state.outageNotifiedAt){await state.update({outageNotifiedAt:null});}
  }
 }finally{running=false;}
}

export function startProviderMonitor(){
 if(process.env.PROVIDER_MONITOR_ENABLED!=="true") {console.log("[provider-monitor] desativado (PROVIDER_MONITOR_ENABLED=true para habilitar)");return;}
 const run=()=>monitorOnce().catch(e=>console.error("[provider-monitor]",e.message));
 setTimeout(run, 10000).unref();timer=setInterval(run,INTERVAL*1000);timer.unref();
}
export function stopProviderMonitor(){if(timer)clearInterval(timer);}

export async function overview(partnerId){
 const providers=await PartnerProvider.findAll({where:{partnerId},order:[["priority","ASC"]]});
 const states=await ProviderHealth.findAll({where:{providerId:{[Op.in]:providers.map(p=>p.id)}}});
 const lookup=new Map(states.map(s=>[s.providerId,s]));
 const codes=await PartnerCode.findAll({where:{partnerId},order:[["createdAt","DESC"]],limit:500});
 return {providers:providers.map(p=>({id:p.id,name:p.name,baseUrl:p.baseUrl,priority:p.priority,status:p.status,
   health:lookup.get(p.id)?{state:lookup.get(p.id).state,latencyMs:lookup.get(p.id).latencyMs,
   lastCheckedAt:lookup.get(p.id).lastCheckedAt,lastGoodAt:lookup.get(p.id).lastGoodAt,lastError:lookup.get(p.id).lastError}:null})),
   codes:codes.map(c=>({id:c.id,code:c.code,label:c.label,status:c.status,providerId:c.providerId})),
   monitorEnabled:process.env.PROVIDER_MONITOR_ENABLED==="true"};
}

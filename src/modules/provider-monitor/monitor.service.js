import http from "node:http";
import https from "node:https";
import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize.js";
import { Partner, PartnerCode, PartnerProvider, ProviderHealth, CodeFailover, CodeServerPool, ProviderHealthEvent } from "../../db/models/index.js";
import { assertPublicUrl, safeLookup } from "../../shared/ssrf.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import { queueRefreshForDownProvider } from "./active-route.service.js";
import { clearResolutionCache } from "./resolve.service.js";
import { sendMail } from "../mail/mail.transport.js";
import { env } from "../../config/env.js";
import { broadcastChange } from "../../realtime/socket.js";
import {getServicePlan} from "../service-plans/plan.service.js";
import { invalidatePartnerServerAlerts } from "./visibility.service.js";
import { createSharedProbe, isNewProbeSample, probeTargetKey } from "./probe-dedup.js";
import { xtreamApiUrl } from "./url-utils.js";
import { healthTransition } from "./health-policy.js";
import { isPlausibleXtreamResponse, smoothLatency } from "./probe-policy.js";
import { noteProbe, pruneAvailability, availabilityForIds } from "./availability.service.js";

const int = (name, fallback, min, max) => Math.max(min,Math.min(max,Number(process.env[name])||fallback));
const INTERVAL = int("PROVIDER_MONITOR_INTERVAL_SECONDS",15,10,3600);
const SLOW = int("PROVIDER_MONITOR_SLOW_MS",1200,300,5000);
const TIMEOUT = int("PROVIDER_MONITOR_TIMEOUT_MS",2000,800,10000);
const CONCURRENCY = int("PROVIDER_MONITOR_CONCURRENCY",4,1,8);
const MAX_PER_CYCLE = int("PROVIDER_MONITOR_MAX_PER_CYCLE",60,5,250);
// Reaproveita sondagens de URLs idênticas entre parcerias, inclusive em lotes adjacentes.
// TTL sempre menor que o intervalo, mesmo se o .env antigo ainda usar 60000 ms.
// Isso impede que várias rodadas reaproveitem uma mesma falha como se fossem novas medições.
const PROBE_TTL_MS = Math.min(int("PROVIDER_MONITOR_DEDUP_TTL_MS",5000,1000,120_000), INTERVAL*1000-1000);
let timer, running=false, alertRunning=false, cycles=0, lastCleanup=0, alertCursor=null;

/** Sondagem leve e limitada: testa o endpoint Xtream real, sem enviar credenciais.
 * latência = tempo até o primeiro byte HTTP; DNS/TCP/TLS são medidos separadamente.
 * A disponibilidade autenticada continua sendo confirmada pelo resolvedor por ativação.
 */
export async function probeServer(raw) {
  let url;
  try { url = await assertPublicUrl(raw); }
  catch(e) { return {good:false,slow:false,latencyMs:TIMEOUT,error:`DNS ou destino indisponível: ${String(e.message).slice(0,100)}`}; }
  const target = xtreamApiUrl(url);
  return new Promise(resolve => {
    const started = performance.now();
    const transport = target.protocol === "https:" ? https : http;
    let settled = false, dnsMs = null, tcpMs = null, tlsMs = null, firstByteMs = null;
    let absoluteTimeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimeout);
      resolve({ ...result, dnsMs, tcpMs, tlsMs, ttfbMs:firstByteMs });
    };
    const req = transport.request(target, {
      method:"GET", lookup:safeLookup, agent:false,
      headers:{"User-Agent":"DeltaTV-Monitor/3.0",Accept:"application/json",Connection:"close"}
    }, res => {
      firstByteMs = Math.round(performance.now()-started);
      const status = res.statusCode;
      const contentType = res.headers['content-type'] || '';
      // Não consumir catálogos nem corpos arbitrários: ler só a primeira amostra.
      // 401/403/404/429 NÃO demonstram API Xtream utilizável.
      if (status !== 200) {
        res.destroy();
        return finish({good:false,slow:false,latencyMs:firstByteMs,error:`Xtream HTTP ${status}`});
      }
      let sampled = Buffer.alloc(0);
      res.on('data', chunk => {
        if (settled) return;
        sampled = Buffer.concat([sampled,chunk.subarray(0,Math.max(0,2048-sampled.length))]);
        if (sampled.length >= 2048 || /\S/.test(sampled.toString('utf8'))) {
          const good = isPlausibleXtreamResponse({status,contentType,sample:sampled.toString('utf8')});
          res.destroy();
          finish({good,slow:good && firstByteMs>SLOW,latencyMs:firstByteMs,error:good?(firstByteMs>SLOW?'Resposta lenta':null):'Resposta não parece ser JSON Xtream'});
        }
      });
      res.on('end',()=>{
        const good=isPlausibleXtreamResponse({status,contentType,sample:sampled.toString('utf8')});
        finish({good,slow:good && firstByteMs>SLOW,latencyMs:firstByteMs,error:good?null:'Resposta vazia ou incompatível com Xtream'});
      });
      res.on('error', e => finish({good:false,slow:false,latencyMs:Math.round(performance.now()-started),error:String(e.message).slice(0,160)}));
    });
    req.on('socket', socket => {
      socket.once('lookup', () => {dnsMs=Math.round(performance.now()-started);});
      socket.once('connect', () => {tcpMs=Math.round(performance.now()-started);});
      socket.once('secureConnect', () => {tlsMs=Math.round(performance.now()-started);});
    });
    absoluteTimeout=setTimeout(()=>{
      req.destroy();
      finish({good:false,slow:false,latencyMs:TIMEOUT,error:'Timeout da sondagem Xtream'});
    },TIMEOUT);
    absoluteTimeout.unref?.();
    req.on('error', e => finish({good:false,slow:false,latencyMs:Math.round(performance.now()-started),error:String(e.message).slice(0,160)}));
    req.end();
  });
}

const sharedProbe = createSharedProbe(probeServer, { ttlMs: PROBE_TTL_MS, maxEntries: 1000 });

async function updateOne(provider) {
  try {
    const r=await sharedProbe(provider.baseUrl);
    const [h]=await ProviderHealth.findOrCreate({where:{providerId:provider.id},defaults:{providerId:provider.id}});
    // Se o lote atual reaproveitou uma medição já aplicada a este provedor, não
    // avance os contadores nem gere um evento de queda/recuperação fictício.
    if (!isNewProbeSample(h.lastCheckedAt, r.sampledAt)) return {stateChanged:false,notify:false};
    const { failures, successes, state } = healthTransition(h, r);
    const oldLatency = h.latencyMs;
    const effectiveLatency = r.good ? smoothLatency(oldLatency,r.latencyMs) : r.latencyMs;
    const stateChanged = state !== h.state;
    const latencyChanged = r.good && oldLatency != null &&
      Math.abs(effectiveLatency - oldLatency) >= Math.max(250, oldLatency * 0.4);
    await h.update({state,latencyMs:effectiveLatency,lastCheckedAt:r.sampledAt,lastGoodAt:r.good?r.sampledAt:h.lastGoodAt,failures,successes,lastError:r.error});
    // Totalização horária, sem guardar cada resposta; falha de métrica não desliga failover.
    try { await noteProbe(provider.id,r); }
    catch (metricError) { console.warn('[provider-monitor] agregado de disponibilidade:', metricError.message); }
    if(stateChanged){
      // Registro de incidente desacoplado: falha de telemetria não derruba o monitor.
      try{await ProviderHealthEvent.create({providerId:provider.id,state,latencyMs:r.latencyMs,note:r.error,occurredAt:r.sampledAt});}
      catch(error){console.warn("[provider-monitor] histórico",error.message)}
    }
    return { stateChanged, notify: stateChanged || latencyChanged, providerId:provider.id, state };
  }catch(e){ console.warn("[provider-monitor] sondagem",provider.id,e.message);return { stateChanged:false, notify:false }; }
}
async function workers(items,fn,n) {
  let next=0;
  await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{
    while(next<items.length){const item=items[next++];await fn(item);}
  }));
}

// Executa com limite fixo de tarefas e memória. Não cria uma requisição por TV nem por código.
export async function monitorOnce() {
  if(running)return;
  running=true;
  try {
    // Mais antigos primeiro (NULL antes dos demais): garante justiça sem OFFSET crescente
    // e prioriza servidores recém-cadastrados. A deduplicação HTTP continua compartilhada.
    const providers = await sequelize.query(`
      SELECT pp.id, pp.base_url AS "baseUrl", pp.partner_id AS "partnerId"
      FROM partner_providers pp
      LEFT JOIN provider_health h ON h.provider_id = pp.id
      WHERE pp.status='active' AND pp.deleted_at IS NULL
      ORDER BY h.last_checked_at ASC NULLS FIRST, pp.id ASC
      LIMIT :limit`, { replacements: { limit: MAX_PER_CYCLE }, type: QueryTypes.SELECT });
    if (!providers.length) return;
    const changedPartnerIds = new Set();
    const newlyDown = new Set();
    let changedState = false;
    await workers(providers,async p=>{
      const result = await updateOne(p);
      if (result.stateChanged) changedState = true;
      if (result.stateChanged && result.state === "down") newlyDown.add(result.providerId);
      if (result.notify) changedPartnerIds.add(p.partnerId);
    },CONCURRENCY);
    // Revalidar caches de roteamento só quando muda a disponibilidade.
    // Uma oscilação de latência não precisa invalidar as sessões existentes.
    if (changedState) { clearMirrorAuth();clearResolutionCache(); }
    // Quando uma origem cai, a seleção futura já a exclui; sinalizar TVs atualmente nela.
    // Não bloqueia a próxima rodada de monitoramento por lentidão no comando remoto.
    // Repetir lotes em ciclos seguintes para redes com mais de 100 TVs, sem
    // executar uma consulta por heartbeat nem concentrar tudo num único ciclo.
    const stillDown = await ProviderHealth.findAll({where:{state:'down',lastCheckedAt:{[Op.gt]:new Date(Date.now()-Math.max(INTERVAL*3000,180000))}},attributes:['providerId'],limit:5,raw:true});
    for (const providerId of new Set([...newlyDown,...stillDown.map(p=>p.providerId)])) {
      void queueRefreshForDownProvider(providerId).catch(e=>console.warn('[provider-monitor] atualização TVs',e.message));
    }
    // Um único aviso por parceria e rodada, nunca um por TV nem por usuário.
    for (const partnerId of changedPartnerIds) {
      invalidatePartnerServerAlerts(partnerId);
      broadcastChange({ partnerId, topic: "server-health" });
    }
    // Estatística agregada a cada 10 rodadas; demonstra economia de rede sem log por URL.
    if ((cycles + 1) % 10 === 0) {
      const m = sharedProbe.stats();
      console.log(`[provider-monitor] sondagens HTTP=${m.requests} reutilizações=${m.reused} coalescências=${m.joined} cache=${m.cached}`);
    }
    // Retenção em 30 dias. Uma exclusão por dia em índice, nunca por sondagem.
    if(Date.now()-lastCleanup>86_400_000){
      lastCleanup=Date.now();
      void pruneAvailability().catch(e=>console.warn('[provider-monitor] retenção de disponibilidade',e.message));
      void ProviderHealthEvent.destroy({where:{occurredAt:{[Op.lt]:new Date(Date.now()-30*86_400_000)}}})
        .catch(e=>console.warn("[provider-monitor] limpeza histórico",e.message));
    }
    // E-mail e milhares de códigos NÃO bloqueiam o loop de sondagem.
    if(++cycles % 3 === 0 && !alertRunning) {
      alertRunning=true;
      void alertOutages().catch(e=>console.error("[provider-monitor] alertas",e.message))
        .finally(()=>{alertRunning=false;});
    }
  }finally{running=false;}
}

// Notifica somente incidentes confirmados, por código, e apenas quando TODAS suas URLs estão DOWN.
async function alertOutages() {
  // Cursor com lote fixo: independe do número total de códigos cadastrados.
  const where = { status: "active", deletedAt:null, ...(alertCursor ? { id: { [Op.gt]: alertCursor } } : {}) };
  let codes = await PartnerCode.findAll({where, attributes:["id","partnerId","code","providerId"],order:[["id","ASC"]],limit:200,raw:true});
  if (!codes.length && alertCursor) {
    alertCursor = null;
    codes = await PartnerCode.findAll({where:{status:"active",deletedAt:null},attributes:["id","partnerId","code","providerId"],order:[["id","ASC"]],limit:200,raw:true});
  }
  if (!codes.length) return;
  alertCursor = codes[codes.length - 1].id;
  const links=await CodeServerPool.findAll({where:{codeId:{[Op.in]:codes.map(c=>c.id)}},attributes:["codeId","providerId"],raw:true});
  const pools=new Map();for(const l of links){if(!pools.has(l.codeId))pools.set(l.codeId,[]);pools.get(l.codeId).push(l.providerId);}
  const providerIds = [...new Set(codes.flatMap(c => [...(pools.get(c.id) || []), c.providerId].filter(Boolean)))];
  const activeProviders=await PartnerProvider.findAll({where:{status:"active",deletedAt:null,id:{[Op.in]:providerIds}},attributes:["id"],raw:true});
  const activeIds=new Set(activeProviders.map(p=>p.id));
  const states=await ProviderHealth.findAll({where:{providerId:{[Op.in]:providerIds}},attributes:["providerId","state","lastCheckedAt"],raw:true});
  const health=new Map(states.map(s=>[s.providerId,s]));
  const known=await CodeFailover.findAll({where:{codeId:{[Op.in]:codes.map(c=>c.id)}},attributes:["id","codeId","outageNotifiedAt"],raw:false});
  const byCode=new Map(known.map(s=>[s.codeId,s]));
  const now=Date.now(), activeCutoff=Math.max(180_000,INTERVAL*3000);
  let emails=0;
  for(const code of codes){
    const ids=(pools.get(code.id)|| (code.providerId?[code.providerId]:[])).filter(id=>activeIds.has(id));
    if(!ids.length)continue;
    const unavailable=ids.every(id=>{
      const h=health.get(id);
      return h?.state==="down" && h.lastCheckedAt && now-new Date(h.lastCheckedAt).getTime()<activeCutoff;
    });
    const recovered=ids.some(id=>["healthy", "slow"].includes(health.get(id)?.state));
    let state=byCode.get(code.id);
    if(!unavailable && (!recovered || !state?.outageNotifiedAt))continue;
    if(recovered && state?.outageNotifiedAt){await state.update({outageNotifiedAt:null});continue;}
    if(!unavailable || state?.outageNotifiedAt)continue;
    if(emails>=20){console.warn("[provider-monitor] lote de alertas limitado; restantes na próxima rodada");break;}
    if(!env.mail.configured)continue;
    if(!(await getServicePlan(code.partnerId)).features.emailAlerts)continue;
    const partner=await Partner.findByPk(code.partnerId,{attributes:["contactEmail"]});
    if(partner?.contactEmail){
      emails++;
      try{
        await sendMail({to:partner.contactEmail,subject:`[Delta TV] Servidores indisponíveis — código ${code.code}`,
          text:`Todos os endereços vinculados ao código ${code.code} estão indisponíveis. Consulte parceiro.deltatv.com.br.`});
        if(!state)state=await CodeFailover.create({codeId:code.id,originalProviderId:code.providerId,currentProviderId:code.providerId});
        await state.update({outageNotifiedAt:new Date()});
      }catch(e){console.error("[provider-monitor] alerta por e-mail",e.message);}
    }
  }
}

export function startProviderMonitor() {
  if(process.env.PROVIDER_MONITOR_ENABLED!=="true") {console.log("[provider-monitor] desativado");return;}
  const run=()=>monitorOnce().catch(e=>console.error("[provider-monitor]",e.message));
  setTimeout(run,10_000).unref();timer=setInterval(run,INTERVAL*1000);timer.unref();
}
export function stopProviderMonitor(){if(timer)clearInterval(timer);}

export async function overview(partnerId) {
  const providers=await PartnerProvider.findAll({where:{partnerId,deletedAt:null},order:[["priority","ASC"]],raw:true});
  const states=providers.length?await ProviderHealth.findAll({where:{providerId:{[Op.in]:providers.map(p=>p.id)}},raw:true}):[];
  const byId=new Map(states.map(s=>[s.providerId,s]));
  const availability=await availabilityForIds(providers.map(p=>p.id));
  const totalCodes=await PartnerCode.count({where:{partnerId,deletedAt:null}});
  const servicePlan=await getServicePlan(partnerId);
  const automated=servicePlan.features.autoPriority;
  const effectiveOrder=[...providers].sort((a,b)=>{
    const healthRank=p=>byId.get(p.id)?.state==="healthy"?0:byId.get(p.id)?.state==="slow"?1:byId.get(p.id)?.state==="down"?3:2;
    return healthRank(a)-healthRank(b) || (automated?(byId.get(a.id)?.latencyMs??1e9)-(byId.get(b.id)?.latencyMs??1e9)||a.priority-b.priority
      :a.priority-b.priority||(byId.get(a.id)?.latencyMs??1e9)-(byId.get(b.id)?.latencyMs??1e9));
  });
  const ranks=new Map(effectiveOrder.map((p,i)=>[p.id,i+1]));
  return {autoPriority:automated,servicePlan:{tier:servicePlan.tier,features:servicePlan.features},providers:providers.map(p=>({id:p.id,name:p.name,baseUrl:p.baseUrl,priority:p.priority,effectivePriority:ranks.get(p.id),status:p.status,
    health:byId.get(p.id)?{state:byId.get(p.id).state,latencyMs:byId.get(p.id).latencyMs,lastCheckedAt:byId.get(p.id).lastCheckedAt,
      lastGoodAt:byId.get(p.id).lastGoodAt,lastError:byId.get(p.id).lastError}:null, availability:availability[p.id] || null})),
    totalCodes, codes:[],
    monitorEnabled:process.env.PROVIDER_MONITOR_ENABLED==="true"};
}

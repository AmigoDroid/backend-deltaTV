import {QueryTypes} from 'sequelize';
import {sequelize} from '../../db/models/index.js';
import {readHostMetrics} from '../system/metrics.js';
import {activeViewers,usageMeterStatus} from './meter.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
import {buildUsageAnalysis} from './usage-analysis.js';
import {USAGE_REQUIRED_COLUMNS,USAGE_MIGRATIONS,summarizeUsageSchema} from './usage-schema.js';

const GB=1e9;
const read=(sql,replacements={})=>sequelize.query(sql,{type:QueryTypes.SELECT,replacements});
const one=async(sql,replacements={})=>(await read(sql,replacements))[0]||null;
const COST_SETTINGS=`SELECT vps_monthly_cents,domain_annual_cents,other_monthly_cents,proxy_cost_per_gb_cents FROM partner_portal_cost_settings WHERE singleton_id=1`;
const ALERT_SETTINGS=`SELECT * FROM partner_portal_usage_alert_settings WHERE singleton_id=1`;

/** Diagnose somente leitura: identifica migrations faltantes sem exigir que a consulta
 * de consumo funcione. Restrito à rota autenticada do Superadmin (ou ao CLI local).
 */
export async function diagnosePortalUsage() {
  const tables=Object.keys(USAGE_REQUIRED_COLUMNS);
  const columns=await read(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema=ANY(current_schemas(false)) AND table_name IN (:tables)`,{tables});
  let migrationsKnown=true,applied=[];
  try {
    applied=(await read('SELECT name FROM "SequelizeMeta" WHERE name IN (:names)',{names:USAGE_MIGRATIONS})).map(x=>x.name);
  } catch(error) {
    if (error?.parent?.code==='42P01' || error?.original?.code==='42P01') migrationsKnown=false;
    else throw error;
  }
  const preliminary=summarizeUsageSchema(columns,applied,{migrationsKnown});
  const settingsRows={};
  for (const table of ['partner_portal_cost_settings','partner_portal_usage_alert_settings']) {
    if (!preliminary.missingTables.includes(table) &&
        !preliminary.missingColumns.some(column=>column.startsWith(`${table}.`))) {
      const setting=await one(`SELECT singleton_id FROM ${table} WHERE singleton_id=1`);
      settingsRows[table]=Boolean(setting);
    }
  }
  return summarizeUsageSchema(columns,applied,{migrationsKnown,settingsRows});
}

export function monthWindow(month) {
  const value=month||new Date().toISOString().slice(0,7);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))throw new AppError(422,'INVALID_MONTH','Mês deve ser AAAA-MM.');
  const start=new Date(`${value}-01T00:00:00.000Z`);
  if(start.getTime()<Date.now()-366*86400000||start.getTime()>Date.now()+31*86400000)throw new AppError(422,'MONTH_OUT_OF_RANGE','Consulte o período recente de até 12 meses.');
  const end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
  return {month:value,start:start.toISOString(),end:end.toISOString()};
}

const OWNER_ALL=`WITH RECURSIVE nodes AS(
 SELECT s.partner_id,s.parent_partner_id,s.partner_id AS root_id,ARRAY[s.partner_id] AS visited
 FROM partner_portal_sellers s WHERE s.parent_partner_id IS NULL
 UNION ALL
 SELECT s.partner_id,s.parent_partner_id,n.root_id,n.visited||s.partner_id
 FROM nodes n JOIN partner_portal_sellers s ON s.parent_partner_id=n.partner_id
 WHERE NOT s.partner_id=ANY(n.visited)
), assigned AS(
 SELECT n.partner_id AS owner_id,n.partner_id AS seller_id,n.root_id FROM nodes n
 UNION
 SELECT c.customer_partner_id,c.seller_partner_id,n.root_id
 FROM partner_portal_access_contracts c JOIN nodes n ON n.partner_id=c.seller_partner_id
)
SELECT a.owner_id::text,a.seller_id::text,a.root_id::text,p.name AS root_name
FROM assigned a JOIN partners p ON p.id=a.root_id`;
const OWNER_SELLER=`WITH RECURSIVE nodes AS(
 SELECT s.partner_id,s.parent_partner_id,ARRAY[s.partner_id] AS visited
 FROM partner_portal_sellers s WHERE s.partner_id=:sellerPartnerId
 UNION ALL
 SELECT s.partner_id,s.parent_partner_id,n.visited||s.partner_id
 FROM nodes n JOIN partner_portal_sellers s ON s.parent_partner_id=n.partner_id
 WHERE NOT s.partner_id=ANY(n.visited)
), assigned AS(
 SELECT n.partner_id AS owner_id,n.partner_id AS seller_id FROM nodes n
 UNION
 SELECT c.customer_partner_id,c.seller_partner_id FROM partner_portal_access_contracts c
 JOIN nodes n ON n.partner_id=c.seller_partner_id
)
SELECT a.owner_id::text,a.seller_id::text,:sellerPartnerId AS root_id,root.name AS root_name
FROM assigned a JOIN partners root ON root.id=:sellerPartnerId`;

export async function usageReport({month,sellerPartnerId=null}={}){
  const window=monthWindow(month);
  const owners=await read(sellerPartnerId?OWNER_SELLER:OWNER_ALL,sellerPartnerId?{sellerPartnerId}:{});
  const permitted=new Set(owners.map(o=>o.owner_id));
  const ownerIds=[...permitted];
  const scopedSql=sellerPartnerId?' AND partner_id IN (:ownerIds)':'';
  const [records,costs,settings]=await Promise.all([
    sellerPartnerId&&!ownerIds.length?Promise.resolve([]):read(`SELECT partner_id::text,media_kind,transport,
      sum(bytes_out)::text AS bytes_out,sum(request_count)::text AS request_count,sum(error_count)::text AS error_count
      FROM partner_portal_usage_hourly WHERE bucket_at>=:start AND bucket_at<:end ${scopedSql}
      GROUP BY partner_id,media_kind,transport`,{...window,ownerIds}),
    one(COST_SETTINGS),one(ALERT_SETTINGS),
  ]);
  if(!costs||!settings)throw new AppError(503,'PORTAL_USAGE_CONFIGURATION_MISSING',
    'Falta a configuração inicial da telemetria no banco. Confira a migração 20261223000001 e seu registro de configuração.');
  const viewerCounts=activeViewers(sellerPartnerId?[...permitted]:null);
  let host=null,hostUnavailable=false;
  if(!sellerPartnerId){try{host=readHostMetrics();}catch{hostUnavailable=true;}}
  const analysis=buildUsageAnalysis({records,owners,month:window.month,costs,alertSettings:settings,host,localViewers:viewerCounts});
  if(hostUnavailable)analysis.alerts.push({code:'HOST_METRICS_UNAVAILABLE',severity:'info',message:'As métricas do host não estão disponíveis nesta instância.'});
  if(sellerPartnerId){analysis.totals.unattributedNodeGb=0;analysis.totals.unattributedRequests=0;delete analysis.finance;analysis.host=null;
    analysis.byMaster=analysis.byMaster.map(({measuredNodeCostCents,allocatedFixedCostCents,partialEstimatedTotalCents,...publicRow})=>publicRow);}
  return {...analysis,settings:sellerPartnerId?undefined:settings,meter:sellerPartnerId?undefined:usageMeterStatus()};
}
export async function updateUsageSettings(input,actor){
  if(actor?.role!=='superadmin')throw new AppError(403,'SUPERADMIN_ONLY','Somente o Superadmin pode alterar alertas da infraestrutura.');
  const rows=await read(`UPDATE partner_portal_usage_alert_settings SET
    monthly_node_gb_budget=:monthlyNodeGbBudget,master_monthly_node_gb_budget=:masterMonthlyNodeGbBudget,
    cpu_percent=:cpuPercent,memory_percent=:memoryPercent,storage_percent=:storagePercent,
    retention_days=:retentionDays,updated_at=now() WHERE singleton_id=1 RETURNING *`,input);
  await audit({actor,action:'portal.usage.alert_settings.updated',entityType:'portal_usage_alert_settings',entityId:null,metadata:input});
  return rows[0];
}
export async function dailyUsage({month,sellerPartnerId=null}={}){
  const window=monthWindow(month);
  const owners=await read(sellerPartnerId?OWNER_SELLER:OWNER_ALL,sellerPartnerId?{sellerPartnerId}:{});
  const permitted=new Set(owners.map(o=>o.owner_id));
  if(sellerPartnerId&&!permitted.size)return [];
  const rows=await read(`SELECT date_trunc('day',bucket_at)::date::text AS day,partner_id::text,transport,sum(bytes_out)::text AS bytes_out
    FROM partner_portal_usage_hourly WHERE bucket_at>=:start AND bucket_at<:end ${sellerPartnerId?'AND partner_id IN (:ownerIds)':''}
    GROUP BY 1,2,3 ORDER BY 1`,{...window,ownerIds:[...permitted]});
  const trend=new Map();
  for(const r of rows){if(sellerPartnerId&&!permitted.has(r.partner_id))continue;
    let item=trend.get(r.day);if(!item){item={day:r.day,nodeBytes:0,nginxUnmetered:false};trend.set(r.day,item)}
    if(r.transport==='node')item.nodeBytes+=Number(r.bytes_out||0);
    if(r.transport==='nginx_unmetered')item.nginxUnmetered=true;
  }
  return [...trend.values()].map(x=>({...x,nodeGb:Math.round(x.nodeBytes/GB*1000)/1000}));
}
export async function topDevices({month,sellerPartnerId=null}={}){
 const window=monthWindow(month);
 const owners=await read(sellerPartnerId?OWNER_SELLER:OWNER_ALL,sellerPartnerId?{sellerPartnerId}:{});
 const permitted=new Set(owners.map(o=>o.owner_id));
 if(sellerPartnerId&&!permitted.size)return [];
 const rows=await read(`SELECT partner_id::text,device_id::text,sum(bytes_out) FILTER(WHERE transport='node')::text AS bytes_out,
    count(*) FILTER (WHERE transport='nginx_unmetered')::int AS nginx_unmetered_buckets,
    sum(request_count) FILTER(WHERE transport='nginx_unmetered')::text AS nginx_unmetered_requests
   FROM partner_portal_usage_hourly WHERE bucket_at>=:start AND bucket_at<:end ${sellerPartnerId?'AND partner_id IN (:ownerIds)':''}
   GROUP BY partner_id,device_id ORDER BY sum(bytes_out) FILTER(WHERE transport='node') DESC NULLS LAST LIMIT 50`,{...window,ownerIds:[...permitted]});
 return rows.filter(x=>!sellerPartnerId||permitted.has(x.partner_id)).slice(0,50).map(x=>({partnerId:x.partner_id,deviceId:x.device_id,
   nodeGb:Math.round(Number(x.bytes_out||0)/GB*1000)/1000,nginxUnmeteredRequests:Number(x.nginx_unmetered_requests||0)}));
}
export async function cleanupUsage(){
  const s=await one(ALERT_SETTINGS);const retentionDays=Math.max(7,Math.min(365,Number(s?.retention_days||60)));
  await sequelize.query(`DELETE FROM partner_portal_usage_hourly WHERE bucket_at < now()-(:days * interval '1 day')`,{replacements:{days:retentionDays}});
  await sequelize.query(`DELETE FROM partner_portal_usage_flushes WHERE created_at < now()-interval '400 days'`);
}

import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {buildUsageAnalysis} from '../../src/modules/partner-portal-usage/usage-analysis.js';
const A='aaaaaaa1-0000-4000-8000-000000000001',B='bbbbbbb1-0000-4000-8000-000000000001',C='ccccccc1-0000-4000-8000-000000000001';
const input=(records,owners)=>({records,owners,month:'2026-11',costs:{vps_monthly_cents:3000,domain_annual_cents:4000,other_monthly_cents:0,proxy_cost_per_gb_cents:120},
 alertSettings:{monthly_node_gb_budget:2,master_monthly_node_gb_budget:1,cpu_percent:85,memory_percent:85,storage_percent:90}});
const owner=(owner_id,root_id,name='Master 1')=>({owner_id,root_id,seller_id:root_id,root_name:name});
const record=(partner_id,transport,bytes_out,request_count,media_kind='live')=>({partner_id,transport,bytes_out:String(bytes_out),request_count:String(request_count),error_count:'0',media_kind});
describe('Etapa 4: apuração parcial segura do PlayerWeb',()=>{
 it('conta bytes servidos por Node, mas não inventa tráfego Nginx nem redirect',()=>{
  const r=buildUsageAnalysis(input([record(A,'node',2_000_000_000,4),record(A,'nginx_unmetered',0,7),record(A,'redirect',0,3)],[owner(A,B)]));
  assert.equal(r.totals.nodeGb,2);assert.equal(r.totals.nginxUnmeteredRequests,7);assert.equal(r.totals.redirectRequests,3);
  assert.equal(r.finance.measuredNodeCostCents,240);assert.equal(r.byMaster[0].allocatedFixedCostCents,3333);assert.equal(r.byMaster[0].partialEstimatedTotalCents,3573);assert.equal(r.finance.costCoverageComplete,false);
  assert.ok(r.alerts.some(a=>a.code==='NGINX_UNMETERED'));
 });
 it('atribui redes por contrato, identifica legados não vinculados sem faturá-los ao Master',()=>{
  const r=buildUsageAnalysis(input([record(A,'node',1_000_000_000,2),record(C,'node',500_000_000,1)],[owner(A,B)]));
  assert.equal(r.byMaster.length,1);assert.equal(r.byMaster[0].nodeGb,1);assert.equal(r.totals.unattributedNodeGb,0.5);
  assert.ok(r.alerts.some(a=>a.code==='NO_COMMERCIAL_OWNER'));
 });
 it('liga alertas apenas quando o limite é alcançado',()=>{
  const base=input([record(A,'node',2_000_000_000,5)],[owner(A,B)]);
  const r=buildUsageAnalysis({...base,host:{cpu:{percent:87},memory:{used:900,total:1000},storage:{used:80,total:100}}});
  const codes=r.alerts.map(a=>a.code);
  assert.ok(codes.includes('MONTHLY_NODE_BUDGET'));
  assert.ok(codes.includes('MASTER_NODE_BUDGET'));
  assert.ok(codes.includes('HOST_CPU'));
  assert.ok(codes.includes('HOST_MEMORY'));
  assert.ok(!codes.includes('HOST_STORAGE'));
 });
 it('custo zero por GB não vira custo real zero; devolve não configurado',()=>{
  const i=input([record(A,'node',1e9,1)],[owner(A,B)]);i.costs.proxy_cost_per_gb_cents=0;
  const r=buildUsageAnalysis(i);assert.equal(r.finance.measuredNodeCostCents,null);assert.equal(r.finance.costPerGbCents,null);
 });
 it('não soma duas vezes um proprietário duplicado em redes conflitantes',()=>{
  const i=input([record(A,'node',1e9,1)],[owner(A,B),owner(A,C,'Master 2')]);
  const r=buildUsageAnalysis(i);assert.equal(r.totals.unattributedNodeGb,1);assert.equal(r.byMaster.length,0);
 });
 it('tráfego segmentado HLS e mídia principal entram na soma correta sem inventar usuários únicos',()=>{
  const i=input([record(A,'node',250_000_000,6,'hls'),record(A,'node',750_000_000,1,'live')],[owner(A,B)]);
  const r=buildUsageAnalysis({...i,localViewers:{[A]:2}});
  assert.equal(r.totals.nodeGb,1);assert.equal(r.byMaster[0].activeViewersLocal,2);
  assert.equal(r.byKind.length,2);
 });
});

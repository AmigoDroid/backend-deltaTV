/* Pure analytics: no SQL, no external services. */
const GB=1e9;
export function buildUsageAnalysis({records,owners,month,costs,alertSettings,host=null,localViewers={}}){
  const ownerToRoot=new Map(), ownerToSeller=new Map(), rootNames=new Map(), duplicateOwners=new Set();
  for(const x of owners){
    const owner=String(x.owner_id),root=String(x.root_id);
    if(ownerToRoot.has(owner)&&ownerToRoot.get(owner)!==root)duplicateOwners.add(owner);
    ownerToRoot.set(owner,root);ownerToSeller.set(owner,String(x.seller_id));rootNames.set(root,String(x.root_name));
  }
  const totals={nodeBytes:0,nodeRequests:0,redirectRequests:0,nginxUnmeteredRequests:0,errors:0,requests:0};
  const groups=new Map(),byKind=new Map(),byPartner=new Map(),rootOwners=new Map();
  for(const [owner,root] of ownerToRoot){if(duplicateOwners.has(owner))continue;
    if(!rootOwners.has(root))rootOwners.set(root,new Set());rootOwners.get(root).add(owner);
  }
  const attributedOwners=[...rootOwners.values()].reduce((n,x)=>n+x.size,0);
  let unattributedNodeBytes=0,unattributedRequests=0;
  for(const r of records){
    const owner=String(r.partner_id),transport=String(r.transport),bytes=Number(r.bytes_out||0),requests=Number(r.request_count||0),errors=Number(r.error_count||0);
    const kind=String(r.media_kind);
    const root=ownerToRoot.get(owner);
    totals.requests+=requests;totals.errors+=errors;
    if(transport==='node'){totals.nodeBytes+=bytes;totals.nodeRequests+=requests;byKind.set(kind,(byKind.get(kind)||0)+bytes);} 
    if(transport==='redirect')totals.redirectRequests+=requests;
    if(transport==='nginx_unmetered')totals.nginxUnmeteredRequests+=requests;
    if(!root||duplicateOwners.has(owner)){if(transport==='node')unattributedNodeBytes+=bytes;unattributedRequests+=requests;continue;}
    const group=groups.get(root)||{rootPartnerId:root,name:rootNames.get(root)||root,partnerIds:new Set(),nodeBytes:0,nodeRequests:0,redirectRequests:0,nginxUnmeteredRequests:0,errors:0,activeViewersLocal:0};
    group.partnerIds.add(owner);group.errors+=errors;
    if(transport==='node'){group.nodeBytes+=bytes;group.nodeRequests+=requests;}
    if(transport==='redirect')group.redirectRequests+=requests;
    if(transport==='nginx_unmetered')group.nginxUnmeteredRequests+=requests;
    groups.set(root,group);
    const p=byPartner.get(owner)||{partnerId:owner,sellerPartnerId:ownerToSeller.get(owner),rootPartnerId:root,nodeBytes:0,nginxUnmeteredRequests:0,redirectRequests:0};
    if(transport==='node')p.nodeBytes+=bytes;
    if(transport==='nginx_unmetered')p.nginxUnmeteredRequests+=requests;
    if(transport==='redirect')p.redirectRequests+=requests;
    byPartner.set(owner,p);
  }
  const costPerGb=Number(costs?.proxy_cost_per_gb_cents||0);
  const fixedMonthlyCents=Number(costs?.vps_monthly_cents||0)+Number(costs?.domain_annual_cents||0)/12+Number(costs?.other_monthly_cents||0);
  const costFor=bytes=>costPerGb?Math.round(bytes/GB*costPerGb):null;
  for(const [root,g] of groups){
    g.activeViewersLocal=[...g.partnerIds].reduce((s,p)=>s+(localViewers[p]||0),0);
    g.partnerCount=g.partnerIds.size;
    // Rateio CONTÁBIL do custo fixo, por contas comerciais vinculadas, não é fatura nem custo medido.
    g.allocatedFixedCostCents=attributedOwners?Math.round(fixedMonthlyCents*(rootOwners.get(root)?.size||0)/attributedOwners):null;
    g.partialEstimatedTotalCents=costPerGb>0&&g.allocatedFixedCostCents!=null?g.allocatedFixedCostCents+costFor(g.nodeBytes):null;
    g.nodeGb=Math.round(g.nodeBytes/GB*1000)/1000;g.measuredNodeCostCents=costFor(g.nodeBytes);
    delete g.partnerIds;groups.set(root,g);
  }
  const list=[...groups.values()].sort((a,b)=>b.nodeBytes-a.nodeBytes);
  const alerts=[];
  const addAlert=(code,severity,message,scope=null)=>alerts.push({code,severity,message,scope});
  const gb=totals.nodeBytes/GB;
  if(Number(alertSettings?.monthly_node_gb_budget)>0&&gb>=Number(alertSettings.monthly_node_gb_budget))addAlert('MONTHLY_NODE_BUDGET','warning','Tráfego Node medido alcançou o limite mensal configurado.');
  const perMaster=Number(alertSettings?.master_monthly_node_gb_budget||0);
  if(perMaster>0)for(const g of list)if(g.nodeBytes/GB>=perMaster)addAlert('MASTER_NODE_BUDGET','warning',`Rede ${g.name}: limite mensal de tráfego Node atingido.`,g.rootPartnerId);
  if(totals.nginxUnmeteredRequests>0)addAlert('NGINX_UNMETERED','info','Há mídia enviada pelo Nginx: o tráfego real total pode ser maior do que os bytes medidos pelo Node.');
  if(unattributedRequests>0)addAlert('NO_COMMERCIAL_OWNER','info','Parte do consumo não possui contrato ou associação comercial inequívoca com um Master.');
  const pct=(used,total)=>total>0?Math.round(100*used/total*10)/10:null;
  const hostUsage=host?{cpuPercent:host.cpu?.percent??null,memoryPercent:pct(host.memory?.used,host.memory?.total),storagePercent:pct(host.storage?.used,host.storage?.total),swapPercent:pct(host.swap?.used,host.swap?.total),network:host.network||null,nodeActiveStreams:host.transmission?.nodeActiveStreams??null}:null;
  if(hostUsage){
    for(const [name,actual,limit] of [['CPU',hostUsage.cpuPercent,alertSettings?.cpu_percent],['MEMORY',hostUsage.memoryPercent,alertSettings?.memory_percent],['STORAGE',hostUsage.storagePercent,alertSettings?.storage_percent]]){
      if(actual!=null&&actual>=Number(limit))addAlert(`HOST_${name}`,'warning',`${name}: ${actual}% de utilização, acima do limite de ${limit}%.`);
    }
    const net=hostUsage.network;
    if(net?.capacityMbps>0&&net.sendBytesPerSecond!=null&&net.sendBytesPerSecond*8/1e6 >= net.capacityMbps*.85)
      addAlert('HOST_NETWORK_CAPACITY','warning',`Tráfego de saída do host alcançou pelo menos 85% da capacidade de rede informada (${net.capacityMbps} Mbps).`);
  }
  return {month,totals:{...totals,nodeGb:Math.round(gb*1000)/1000,unattributedNodeGb:Math.round(unattributedNodeBytes/GB*1000)/1000,unattributedRequests},
    finance:{fixedMonthlyCents:Math.round(fixedMonthlyCents),measuredNodeCostCents:costFor(totals.nodeBytes),costPerGbCents:costPerGb||null,
      costCoverageComplete:totals.nginxUnmeteredRequests===0&&unattributedRequests===0,method:'Estimativa: bytes de saída HTTP Node × custo/GB informado; não é fatura da VPS.'},
    byMaster:list,byPartner:[...byPartner.values()].sort((a,b)=>b.nodeBytes-a.nodeBytes).slice(0,100),
    byKind:[...byKind].map(([kind,bytes])=>({kind,bytes,nodeGb:Math.round(bytes/GB*1000)/1000})).sort((a,b)=>b.bytes-a.bytes),
    host:hostUsage,alerts,coverage:{nodeBytesMeasured:true,nginxBytesMeasured:false,redirectOriginBytesMeasured:false,nodeIncludesHlsSegments:true,viewersProcessLocal:true},
    caveat:'Medição parcial do tráfego HTTP servido pelo Node no PlayerWeb. Tráfego X-Accel/Nginx requer logs do Nginx para medir bytes; redirects transferem mídia fora da VPS. Custo fixo por Master é rateio contábil conforme contas vinculadas, e custo variável só cobre Node. Não representa lucro ou fatura real.'};
}


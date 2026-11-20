#!/usr/bin/env node
/** Read-only inventory of legacy financial IDs. No backfill, no payment API. */
import {writeFile} from 'node:fs/promises';
import {Client} from 'pg';

const url=process.env.DATABASE_URL_TEST;
if(process.env.DELTA_FINANCE_DB_CONFIRM!=='DISPOSABLE'||!url){
  console.error('Exige DATABASE_URL_TEST de PostgreSQL descartável e DELTA_FINANCE_DB_CONFIRM=DISPOSABLE.');
  process.exitCode=2;
}else{
  const parsed=new URL(url);
  if(!['localhost','127.0.0.1','::1'].includes(parsed.hostname)){
    console.error('Recusado: a rotina de auditoria não acessa bancos remotos ou produção.');
    process.exitCode=2;
  }else{
    const client=new Client({connectionString:url});
    const report={generatedAt:new Date().toISOString(),database:'LOCAL_DISPOSABLE',noBackfill:true,
      definitions:'Comparação somente de identificadores históricos; não significa que devam ser migrados para o livro novo.',
      sources:[],warnings:[]};
    try{
      await client.connect();
      await client.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
      const maxRows=Math.min(5000,Math.max(1,Number.parseInt(process.env.REPORT_LIMIT||'1000',10)||1000));
      const sources=[
        {name:'pix_charges',sql:`SELECT x.id::text source_id,p.owner_admin_id::text owner_admin_id,x.partner_id::text partner_id,
          x.provider, x.provider_ref source_reference,'pix'::text method,x.amount_cents::bigint amount_cents,x.status
          FROM pix_charges x JOIN partners p ON p.id=x.partner_id ORDER BY x.created_at DESC LIMIT $1`},
        {name:'payments',sql:`SELECT x.id::text source_id,p.owner_admin_id::text owner_admin_id,p.id::text partner_id,
          x.provider,x.provider_ref source_reference,x.method,x.amount_cents::bigint amount_cents,x.status
          FROM payments x LEFT JOIN invoices i ON i.id=x.invoice_id
          LEFT JOIN licenses l ON l.id=x.license_id
          LEFT JOIN partners p ON p.id=COALESCE(i.partner_id,l.partner_id)
          ORDER BY x.paid_at DESC LIMIT $1`},
        {name:'partner_portal_stock_orders',sql:`SELECT x.id::text source_id,p.owner_admin_id::text owner_admin_id,
          p.id::text partner_id,x.payment_gateway provider,x.provider_ref source_reference,
          x.settlement_method method,x.total_cents::bigint amount_cents,x.status
          FROM partner_portal_stock_orders x JOIN partners p ON p.id=x.seller_partner_id
          ORDER BY x.created_at DESC LIMIT $1`},
      ];
      const ledgerExists=(await client.query("SELECT to_regclass('public.admin_network_charges') IS NOT NULL AS ok")).rows[0].ok;
      for(const source of sources){
        const present=(await client.query('SELECT to_regclass($1) IS NOT NULL AS ok',[`public.${source.name}`])).rows[0].ok;
        if(!present){report.warnings.push(`${source.name}: tabela não encontrada; fonte ignorada`);continue;}
        const {rows}=await client.query(source.sql,[maxRows]);
        // Match IDs in one indexed batch per source: avoids one query per historical row.
        const references=[...new Set(rows.filter(r=>r.source_reference&&r.provider)
          .map(r=>String(r.provider)+'\u0001'+String(r.source_reference)))];
        const providers=[...new Set(rows.filter(r=>r.source_reference&&r.provider).map(r=>r.provider))];
        const refs=[...new Set(rows.filter(r=>r.source_reference&&r.provider).map(r=>r.source_reference))];
        const ledger=ledgerExists&&references.length?(await client.query(`SELECT id::text id,
          owner_admin_id::text owner_id,partner_id::text partner_id,
          amount_cents::bigint amount_cents,method,provider,provider_ref
          FROM admin_network_charges WHERE provider=ANY($1::text[])
            AND provider_ref=ANY($2::text[]) LIMIT 10000`,[providers,refs])).rows:[];
        const byRef=new Map();
        for(const item of ledger){
          const key=item.provider+'\u0001'+item.provider_ref;
          byRef.set(key,[...(byRef.get(key)||[]),item]);
        }
        const comparisons=rows.map(r=>{
          const related=byRef.get(r.provider+'\u0001'+r.source_reference)||[];
          const reasons=[];
          if(!r.owner_admin_id)reasons.push('OWNER_HISTORICO_AUSENTE');
          if(!r.source_reference)reasons.push('SEM_ID_EXTERNO');
          if(!related.length)reasons.push('SEM_CORRESPONDENCIA_EXATA_NO_LIVRO_NOVO');
          if(related.length>1)reasons.push('MULTIPLOS_MATCHES');
          if(related.some(e=>e.owner_id!==r.owner_admin_id||e.partner_id!==r.partner_id))reasons.push('DIVERGENCIA_TITULARIDADE');
          if(related.some(e=>Number(e.amount_cents)!==Number(r.amount_cents)))reasons.push('DIVERGENCIA_VALOR');
          return {sourceId:r.source_id,ownerAdminId:r.owner_admin_id,partnerId:r.partner_id,
            provider:r.provider,method:r.method,sourceReference:r.source_reference,
            amountCents:Number(r.amount_cents),status:r.status,networkChargeId:related[0]?.id||null,reasons};
        });
        report.sources.push({name:source.name,scanned:comparisons.length,
          limited:comparisons.length===maxRows,records:comparisons});
      }
      await client.query('COMMIT');
      const output=process.argv[2]||'legacy-network-charges-report.json';
      await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
      console.log(`Relatório READ ONLY salvo em ${output}; fontes: ${report.sources.length}. Nenhum dado foi migrado.`);
    }catch(error){
      await client.query('ROLLBACK').catch(()=>{});
      console.error('Relatório falhou; sem modificações:',error.code||error.name);
      process.exitCode=1;
    }finally{await client.end().catch(()=>{});}
  }
}

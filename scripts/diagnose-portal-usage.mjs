/** Diagnóstico local, somente leitura. Não imprime dados de parceiros nem credenciais. */
import { sequelize } from '../src/db/sequelize.js';
import { diagnosePortalUsage, monthWindow, usageReport, dailyUsage, topDevices } from '../src/modules/partner-portal-usage/usage.service.js';

const month = process.argv[2] || new Date().toISOString().slice(0, 7);
const pgCode = error => error?.parent?.code ?? error?.original?.code ?? error?.cause?.code ?? null;
async function main() {
  monthWindow(month); // Confirma que o período é válido sem consultar o banco.
  await sequelize.authenticate();
  const schema = await diagnosePortalUsage();
  console.log('Esquema do monitoramento:', JSON.stringify(schema,null,2));
  if (!schema.ready) {
    console.error('Pendência no esquema: faça backup, execute npm run db:migrate e revise o status das migrações.');
    process.exitCode=2;
    return;
  }
  const checks=[
    ['usage',async()=>{const r=await usageReport({month});return `redes=${r.byMaster.length} bytesNode=${r.totals.nodeBytes}`;}],
    ['daily',async()=>`dias=${(await dailyUsage({month})).length}`],
    ['devices',async()=>`dispositivos=${(await topDevices({month})).length}`],
  ];
  for (const [name,fn] of checks) {
    try { console.log(`${name}: OK — ${await fn()}`); }
    catch (error) {
      console.error(`${name}: ERRO ${error.name} pgCode=${pgCode(error)||'indisponível'}`);
      process.exitCode=1;
    }
  }
}
try { await main(); }
catch(error) {
  console.error(`Falha no diagnóstico: ${error.name||'Error'} pgCode=${pgCode(error)||'indisponível'}`);
  process.exitCode=1;
} finally { await sequelize.close().catch(()=>{}); }

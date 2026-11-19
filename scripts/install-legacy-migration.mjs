#!/usr/bin/env node
/** Instala apenas o registro das rotas do inventário. Sem migrações nem alterações de tabelas. */
import { readFileSync, copyFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const APPLY = process.argv.includes('--apply');
if (APPLY) {
  console.error('A migração de clientes legados foi arquivada por decisão de produto. Instalação de rotas proibida.');
  process.exit(3);
}
const root = resolve(process.cwd());
const file = resolve(root, 'src/modules/admin.routes.js');
const service = resolve(root, 'src/modules/legacy-migration/legacy-migration.routes.js');
if (!existsSync(file) || !existsSync(service)) {
  console.error('ERRO: execute na raiz do backend DeltaTV, após extrair o ZIP.');
  process.exit(2);
}
const src = readFileSync(file,'utf8');
const importText = 'import legacyMigration from "./legacy-migration/legacy-migration.routes.js";';
const mountText = 'router.use("/devices/legacy-migration", legacyMigration);';
const deviceImport = 'import devices from "./devices/device.routes.js";';
const deviceMount = 'router.use("/devices", devices);';
if (!src.includes(deviceImport) || !src.includes(deviceMount)) {
  console.error('ERRO: formato desconhecido de admin.routes.js. Nenhum arquivo alterado.');
  process.exit(3);
}
let next = src;
if (!next.includes(importText)) next = next.replace(deviceImport,deviceImport+'\n'+importText);
if (!next.includes(mountText)) next = next.replace(deviceMount,mountText+'\n'+deviceMount);
if (next === src) { console.log('Rotas já instaladas (idempotente).'); process.exit(0); }
if (!APPLY) {
  console.log('Migração legada arquivada; rotas não serão registradas.');
  console.log('Somente este arquivo seria modificado. Banco, app.js e mensagens para TVs não serão alterados.');
  console.log('Instalação desativada por decisão de produto.');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const backup = file+'.backup-'+stamp;
copyFileSync(file,backup);
const temp = file+'.next-'+process.pid;
writeFileSync(temp,next,{encoding:'utf8',mode:0o644});
renameSync(temp,file);
console.log('Rotas registradas; backup:',backup);

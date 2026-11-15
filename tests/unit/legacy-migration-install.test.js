import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const installer = new URL('../../scripts/install-legacy-migration.mjs',import.meta.url).pathname;
test('instalador faz só o registro de rotas e é idempotente',()=>{
  const dir=mkdtempSync(join(tmpdir(),'delta-legacy-'));
  try {
    mkdirSync(join(dir,'src/modules/legacy-migration'),{recursive:true});
    const file=join(dir,'src/modules/admin.routes.js');
    writeFileSync(file,'import devices from "./devices/device.routes.js";\nrouter.use("/devices", devices);\n');
    writeFileSync(join(dir,'src/modules/legacy-migration/legacy-migration.routes.js'),'// fixture');
    const dry=spawnSync(process.execPath,[installer],{cwd:dir,encoding:'utf8'});
    assert.equal(dry.status,0); assert.doesNotMatch(readFileSync(file,'utf8'),/legacyMigration/);
    for(let i=0;i<2;i++) assert.equal(spawnSync(process.execPath,[installer,'--apply'],{cwd:dir,encoding:'utf8'}).status,0);
    const src=readFileSync(file,'utf8');
    assert.equal((src.match(/import legacyMigration/g)||[]).length,1);
    assert.equal((src.match(/router.use\("\/devices\/legacy-migration"/g)||[]).length,1);
    assert.match(src,/router.use\("\/devices", devices\)/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

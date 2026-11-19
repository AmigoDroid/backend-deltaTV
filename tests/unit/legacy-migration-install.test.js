import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const installer = new URL('../../scripts/install-legacy-migration.mjs',import.meta.url).pathname;
// A decisão de produto arquivou a migração; o instalador antigo não pode mais montar suas rotas.
test('instalador arquivado recusa --apply sem modificar roteador de admin',()=>{
  const dir=mkdtempSync(join(tmpdir(),'delta-legacy-'));
  try {
    mkdirSync(join(dir,'src/modules/legacy-migration'),{recursive:true});
    const file=join(dir,'src/modules/admin.routes.js');
    const original='import devices from "./devices/device.routes.js";\nrouter.use("/devices", devices);\n';
    writeFileSync(file,original);
    writeFileSync(join(dir,'src/modules/legacy-migration/legacy-migration.routes.js'),'// fixture');
    const dry=spawnSync(process.execPath,[installer],{cwd:dir,encoding:'utf8'});
    assert.equal(dry.status,0);
    assert.match(dry.stdout,/arquivad/i);
    for(let i=0;i<2;i++){
      const result=spawnSync(process.execPath,[installer,'--apply'],{cwd:dir,encoding:'utf8'});
      assert.equal(result.status,3);
      assert.match(result.stderr,/arquivad/i);
      assert.equal(readFileSync(file,'utf8'),original);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

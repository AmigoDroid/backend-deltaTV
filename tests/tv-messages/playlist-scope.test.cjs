const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
test('Cadastro por URL rejeita ausência de sessão e sessão de outra TV antes de sondar a origem',async()=>{
 let probes=0,reads=0;
 class AppError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code}}
 const context=vm.createContext({console,URL,Date,String});
 const exports={
  sequelize:{Op:{ne:Symbol('ne')}},
  '../../db/models/index.js':{sequelize:{},Activation:{},Device:{findOne:async()=>{reads++;return null}}},
  '../../shared/errors.js':{AppError},'../../shared/audit.js':{audit:async()=>{}},
  '../../shared/mac.js':{normalizeMac:s=>s},'../../shared/crypto.js':{encryptSecret:s=>s},
  '../../shared/ssrf.js':{assertPublicUrl:async()=>{probes++}},
  '../access/access.service.js':{checkActivation:async()=>{}},
  '../xtream/xtream.service.js':{probeAccount:async()=>{probes++},xtreamFromUrl:()=>{probes++}},
  '../mirror/mirror.cache.js':{dropMirrorAuth:()=>{}}
 };
 const file=path.resolve(__dirname,'../../src/modules/devices/playlist-by-url.service.js');
 const mod=new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context});
 await mod.link(name=>{const values=exports[name];assert.ok(values,name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v)},{context})});await mod.evaluate();
 const input={mac:'AA:BB:CC:DD:EE:FF',name:'Minha lista',url:'http://example.test/list'};
 await assert.rejects(mod.namespace.addListByUrl(input),e=>e.status===401&&e.code==='DEVICE_KEY_REQUIRED');assert.equal(reads,0);
 await assert.rejects(mod.namespace.addListByUrl({...input,authorizedDeviceId:'outro'}),e=>e.status===403&&e.code==='DEVICE_SCOPE_MISMATCH');assert.equal(reads,1);assert.equal(probes,0);
});

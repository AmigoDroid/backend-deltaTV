const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const express=require('express');
const {z}=require('zod');
const {PGlite}=require('@electric-sql/pglite');
const {Sequelize,QueryTypes}=require('sequelize');
const {injectReplacements}=require('sequelize/lib/utils/sql');
const root=path.resolve(__dirname,'../..');
const pg=new PGlite(), dialect=new Sequelize('postgres://test:test@localhost/test',{logging:false});
const ids=Object.fromEntries(['partner','other','sender','otherSender','device','device2','foreign','activation','activation2','foreignAct','license'].map(k=>[k,randomUUID()]));
let server,base,migration;const audit=[];
class AppError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code}}
const db={async query(sql,opts={}){const expanded=injectReplacements(sql,dialect.dialect,opts.replacements||{});const conn=opts.transaction||pg;const result=await conn.query(expanded);return opts.type===QueryTypes.SELECT?result.rows:[result.rows,result]},transaction:fn=>pg.transaction(fn)};
const users={admin:{id:ids.sender,role:'superadmin'},partner:{id:ids.sender,role:'partner',partnerId:ids.partner},other:{id:ids.otherSender,role:'partner',partnerId:ids.other},support:{id:randomUUID(),role:'support'},broken:{id:randomUUID(),role:'partner'}};
const context=vm.createContext({console,Date,Set,JSON,Number,Promise,Buffer,process,setTimeout,clearTimeout});
function synthetic(exports){return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v)},{context})}
async function loadRoutes(){
 const file=path.join(root,'src/modules/tv-messages/routes.js');const mod=new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context,identifier:file});
 await mod.link(async name=>{
 if(name==='express')return synthetic({Router:express.Router});
 if(name==='node:crypto')return synthetic(require('node:crypto'));
 if(name==='sequelize')return synthetic({QueryTypes});
 if(name==='zod')return synthetic({z});
 if(name==='express-rate-limit')return synthetic({default:()=> (_req,_res,next)=>next()});
 if(name.endsWith('models/index.js'))return synthetic({sequelize:db,Partner:{findByPk:async()=>({status:'active'})}});
 if(name.endsWith('authenticate.js'))return synthetic({authenticate:(req,res,next)=>{req.user=users[req.headers.authorization];if(!req.user)return next(new AppError(401,'AUTH','Auth'));next()}});
 if(name.endsWith('access.middleware.js'))return synthetic({requireDevice:()=> (req,res,next)=>{if(req.headers.authorization!=='tv')return next(new AppError(401,'AUTH','Auth'));req.device={activation:{deviceId:ids.device}};next()}});
 if(name.endsWith('access.policy.js'))return synthetic({effectivePartnerStatus:p=>p.status});
 if(name.endsWith('validate.js'))return synthetic({validate:schemas=>(req,res,next)=>{try{req.valid={};for(const k of Object.keys(schemas))req.valid[k]=schemas[k].parse(req[k]||{});next()}catch(e){e.status=400;next(e)}}});
 if(name.endsWith('errors.js'))return synthetic({AppError});
 if(name.endsWith('audit.js'))return synthetic({audit:async row=>audit.push(row),actorOf:req=>req.user});
 if(name==='./policy.js'){const p=new vm.SourceTextModule(fs.readFileSync(path.join(path.dirname(file),'policy.js'),'utf8'),{context});await p.link(()=>{});return p}
 throw Error(name);
 });await mod.evaluate();return mod.namespace;
}
async function call(url,{actor='partner',body,method=body?'POST':'GET'}={}){const r=await fetch(base+url,{method,headers:{Authorization:actor,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}
const payload=()=>({audience:'all',deviceIds:[],title:'Comunicado de teste',message:'Mensagem importante para os clientes.',expiresInDays:7,requestId:randomUUID()});
before(async()=>{
 await pg.exec(`CREATE TABLE devices(id uuid PRIMARY KEY);CREATE TABLE licenses(id uuid PRIMARY KEY,owner_partner_id uuid);CREATE TABLE activations(id uuid PRIMARY KEY,device_id uuid REFERENCES devices(id),partner_id uuid,license_id uuid,granted_license_id uuid,mac varchar(17),playlist_name text,status text);`);
 migration=require(path.join(root,'src/db/migrations/20261212000001-tv-messages.cjs'));
 const adapter={sequelize:{transaction:fn=>pg.transaction(t=>fn(t)),query:(sql,o)=>o.transaction.exec(sql)}};await migration.up(adapter);
 await pg.query('INSERT INTO devices VALUES ($1),($2),($3)',[ids.device,ids.device2,ids.foreign]);
 await pg.query('INSERT INTO licenses VALUES ($1,$2)',[ids.license,ids.partner]);
 await pg.query(`INSERT INTO activations VALUES ($1,$2,$3,NULL,NULL,'AA:BB:CC:DD:EE:01','Sala','active'),($4,$5,NULL,$6,NULL,'AA:BB:CC:DD:EE:02','Quarto','blocked'),($7,$8,$9,NULL,NULL,'AA:BB:CC:DD:EE:03','Outro','active')`,[ids.activation,ids.device,ids.partner,ids.activation2,ids.device2,ids.license,ids.foreignAct,ids.foreign,ids.other]);
 const routes=await loadRoutes();const app=express();app.use(express.json());app.use('/panel',routes.panelMessages);app.use('/client',routes.clientMessages);app.use((e,req,res,next)=>res.status(e.status||500).json({message:e.message,code:e.code}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(r=>server.close(r));await pg.close();await dialect.close()});
test('Escopo fechado: sem login, suporte e parceiro sem vínculo são negados',async()=>{for(const actor of ['invalid','support','broken'])assert.ok([401,403].includes((await call('/panel/recipients',{actor})).status))});
test('Busca inclui licença própria e exclui outra carteira; busca parametrizada',async()=>{let r=await call('/panel/recipients');assert.equal(r.status,200);assert.equal(r.data.total,2);assert.equal((await call('/panel/recipients?q='+encodeURIComponent("' OR 1=1 --"))).data.total,0);assert.equal((await call('/panel/recipients',{actor:'admin'})).data.total,3)});
test('Seleção vazia e TV estrangeira rejeitadas sem criar campanha',async()=>{assert.equal((await call('/panel/preview',{body:{audience:'selected',deviceIds:[]}})).status,400);assert.equal((await call('/panel',{body:{...payload(),audience:'selected',deviceIds:[ids.foreign]}})).status,403);assert.equal((await pg.query('SELECT COUNT(*)::int count FROM tv_message_campaigns')).rows[0].count,0)});
let campaign,request;
test('Envio atômico, deduplicação por TV e idempotência',async()=>{await pg.query('INSERT INTO activations SELECT $1,device_id,partner_id,license_id,granted_license_id,mac,playlist_name,status FROM activations WHERE id=$2',[randomUUID(),ids.activation]);request=payload();let r=await call('/panel',{body:request});assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.data.total,2);campaign=r.data.id;r=await call('/panel',{body:request});assert.equal(r.status,200);assert.equal(r.data.id,campaign);assert.equal((await call('/panel',{body:{...request,title:'Outro texto'}})).status,409);assert.ok(audit.length)});
test('Histórico e cancelamento isolados entre parceiros',async()=>{assert.equal((await call('/panel',{actor:'other'})).data.data.length,0);assert.equal((await call('/panel/'+campaign+'/cancel',{actor:'other',body:{}})).status,404);const r=await call('/panel');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.data[0].total,2)});
test('Inbox exige sessão da TV e confirma leitura de forma idempotente',async()=>{assert.equal((await call('/client')).status,401);let r=await call('/client',{actor:'tv'});assert.equal(r.data.data[0].id,campaign);r=await call('/client/'+campaign+'/read',{actor:'tv',body:{}});assert.equal(r.status,200,JSON.stringify(r));assert.equal((await call('/client/'+campaign+'/read',{actor:'tv',body:{}})).status,200);assert.equal((await call('/client',{actor:'tv'})).data.data.length,0);assert.equal((await call('/panel')).data.data[0].read,1)});
test('Revogação de propriedade impede entrega pendente',async()=>{const r=await call('/panel',{body:payload()});assert.equal(r.status,201);await pg.query('UPDATE activations SET partner_id=$1 WHERE device_id=$2',[ids.other,ids.device]);assert.equal((await call('/client',{actor:'tv'})).data.data.length,0);await pg.query('UPDATE activations SET partner_id=$1 WHERE device_id=$2',[ids.partner,ids.device])});
test('Cancelamento e validade retiram mensagens do inbox',async()=>{let rows=(await call('/panel')).data.data;for(const r of rows)assert.equal((await call('/panel/'+r.id+'/cancel',{body:{}})).status,200);assert.equal((await call('/client',{actor:'tv'})).data.data.length,0);const r=await call('/panel',{body:payload()});await pg.query("UPDATE tv_message_campaigns SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[r.data.id]);assert.equal((await call('/client',{actor:'tv'})).data.data.length,0);assert.equal((await call('/client/'+r.data.id+'/read',{actor:'tv',body:{}})).status,404)});
test('Conteúdo vazio, prazo inválido e paginação negativa são rejeitados',async()=>{assert.equal((await call('/panel',{body:{...payload(),title:' '}})).status,400);assert.equal((await call('/panel',{body:{...payload(),expiresInDays:31}})).status,400);assert.equal((await call('/panel?page=-1')).status,400)});

test('Migração reversa remove somente as tabelas novas',async()=>{
 await migration.down({sequelize:{transaction:fn=>pg.transaction(fn)},dropTable:(name,o)=>o.transaction.exec('DROP TABLE '+name)});
 const r=await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
 assert.ok(r.rows.some(t=>t.tablename==='activations'));assert.ok(!r.rows.some(t=>t.tablename==='tv_message_campaigns'));
});

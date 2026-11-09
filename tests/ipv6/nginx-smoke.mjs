// Teste opcional com Nginx real: NGINX_BIN=/caminho/nginx node tests/ipv6/nginx-smoke.mjs
import http from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';process.env.ALLOW_PRIVATE_SOURCES='true';process.env.NGINX_MEDIA_PROXY='true';
const {relay}=await import('../../src/shared/relay.js');
const binary=process.env.NGINX_BIN;if(!binary)throw new Error('Defina NGINX_BIN para executar');
const listen=async(s,host)=>{s.listen(0,host);await once(s,'listening');return s.address().port};
const close=async s=>{s.closeAllConnections();await new Promise(r=>s.close(r))};
const origin=http.createServer((req,res)=>{
 if(req.url==='/redirect'&&req.method!=='HEAD'){res.writeHead(302,{location:'/file'});res.end();return;}
 res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
 if(req.headers.range){res.writeHead(206,{'Content-Range':'bytes 2-4/6'});res.end('cde');}else res.end('abcdef');
});
const op=await listen(origin,'127.0.0.1');
const api=http.createServer((req,res)=>relay(req,res,`http://127.0.0.1:${op}${req.url}`,{media:true}).catch(e=>{res.statusCode=e.status||500;res.end(e.message)}));
const ap=await listen(api,'127.0.0.1');
const reservation=http.createServer();const np=await listen(reservation,'::1');await close(reservation);
const dir=await mkdtemp(tmpdir()+'/delta-nginx-');
const media=(await readFile(new URL('../../nginx/deltatv-media.conf',import.meta.url),'utf8')).replaceAll('127.0.0.1:3000',`127.0.0.1:${ap}`);
const apiLocation=(await readFile(new URL('../../nginx/api-location.example.conf',import.meta.url),'utf8')).replaceAll('127.0.0.1:3000',`127.0.0.1:${ap}`);
const cfg=`${process.getuid?.() === 0 ? "user root;" : ""} daemon off; master_process off; pid ${dir}/pid; error_log ${dir}/error.log; events {} http { access_log off; client_body_temp_path ${dir}/client; proxy_temp_path ${dir}/proxy; fastcgi_temp_path ${dir}/fastcgi; uwsgi_temp_path ${dir}/uwsgi; scgi_temp_path ${dir}/scgi; server { listen [::1]:${np}; ${apiLocation}\n${media}\n} }`;
await writeFile(dir+'/nginx.conf',cfg);execFileSync(binary,['-t','-c',dir+'/nginx.conf','-p',dir]);
const proc=spawn(binary,['-c',dir+'/nginx.conf','-p',dir]);let err='';proc.stderr.on('data',d=>err+=d);
async function request(path){return new Promise((resolve,reject)=>http.get(`http://[::1]:${np}${path}`,{headers:{range:'bytes=2-4'}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}))}).on('error',reject));}
try{
 let ready=false;for(let i=0;i<40;i++){try{await request('/file');ready=true;break}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.ok(ready,err);
 for(const path of ['/file','/redirect']){const result=await request(path);assert.equal(result.status,206,JSON.stringify(result));assert.equal(result.body,'cde');assert.equal(result.headers.location,undefined);assert.equal(result.headers['x-delta-origin-target'],undefined);assert.equal(result.headers['content-range'],'bytes 2-4/6');console.log(path,result.headers['x-delta-media-transport'],'IPv6 -> Nginx -> IPv4 OK');}
}finally{proc.kill('SIGTERM');await once(proc,'exit');await close(api);await close(origin);}

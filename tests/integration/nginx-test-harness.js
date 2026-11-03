// Set NGINX_TEST_BINARY to exercise an actual Nginx gateway in local tests.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
export async function startNginxGateway(apiPort) {
 const binary=process.env.NGINX_TEST_BINARY;
 if(!binary)return null;
 const prefix=fs.mkdtempSync(path.join(os.tmpdir(),'delta-nginx-'));
 const reserve=http.createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',prefix+'/key.pem','-out',prefix+'/cert.pem','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const snippet=fs.readFileSync(new URL('../../nginx/deltatv-media.conf',import.meta.url),'utf8').replace('error_log /var/log/nginx/deltatv-media-error.log crit;','error_log stderr crit;');
 const conf=`user ${process.getuid?.() === 0 ? "root" : "nobody"};\npid ${prefix}/nginx.pid;\nerror_log ${prefix}/error.log warn;\nevents { worker_connections 128; }\nhttp { access_log off; client_body_temp_path ${prefix}/body; proxy_temp_path ${prefix}/proxy; fastcgi_temp_path ${prefix}/fastcgi; uwsgi_temp_path ${prefix}/uwsgi; scgi_temp_path ${prefix}/scgi; server { listen 127.0.0.1:${port} ssl; ssl_certificate ${prefix}/cert.pem; ssl_certificate_key ${prefix}/key.pem; ${snippet}\nlocation / { proxy_pass http://127.0.0.1:${apiPort}; proxy_http_version 1.1; proxy_set_header X-Delta-Media-Gateway deltatv-media-v1; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_buffering off; } } }`;
 fs.writeFileSync(prefix+'/nginx.conf',conf);
 execFileSync(binary,['-p',prefix,'-c',prefix+'/nginx.conf','-t'],{stdio:'pipe'});
 const child=spawn(binary,['-p',prefix,'-c',prefix+'/nginx.conf','-g','daemon off; master_process off;'],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const ca=fs.readFileSync(prefix+'/cert.pem');
 const request=(input,options={})=>new Promise((resolve,reject)=>{
  const url=new URL(input),transport=url.protocol==='https:'?https:http;
  const req=transport.request(url,{method:options.method||'GET',headers:options.headers,ca},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{
    const body=Buffer.concat(chunks),headers=new Headers();for(const [key,value]of Object.entries(res.headers))if(value!=null)headers.set(key,Array.isArray(value)?value.join(','):value);
    resolve({status:res.statusCode,headers,ok:res.statusCode>=200&&res.statusCode<300,text:async()=>body.toString(),json:async()=>JSON.parse(body.toString()),arrayBuffer:async()=>body});
   });
  });req.on('error',reject);if(options.body)req.write(options.body);req.end();
 });
 let ready=false;
 for(let i=0;i<60;i++){
  if(child.exitCode!=null)break;
  try{await request(`https://127.0.0.1:${port}/_deltatv_media`);ready=true;break;}catch{await new Promise(r=>setTimeout(r,25));}
 }
 if(!ready){child.kill();throw Error('Nginx failed to start: '+stderr+' '+fs.readFileSync(prefix+'/error.log','utf8'));}
 return {base:`https://127.0.0.1:${port}`,fetch:request,async close(){const exited=once(child,'exit');child.kill('SIGQUIT');await exited;fs.rmSync(prefix,{recursive:true,force:true});}};
}

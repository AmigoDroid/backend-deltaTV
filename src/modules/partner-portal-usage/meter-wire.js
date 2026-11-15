/* Instrumentação do corpo HTTP sem dependências de banco. */
export const byteLen=(chunk,encoding)=>chunk==null?0:Buffer.isBuffer(chunk)?chunk.length:chunk instanceof Uint8Array?chunk.byteLength:typeof chunk==='string'?Buffer.byteLength(chunk,typeof encoding==='string'?encoding:'utf8'):0;
/** Instrumenta um único request autenticado do PlayerWeb. Não interfere no protocolo HTTP. */
export function instrumentPortalResponse(res,{partnerId,deviceId,sessionId,kind},{add,touchSession,liveSessions,isUuid}) {
  if(!isUuid(partnerId))return res;
  const begin=Date.now();let closed=false;
  if(kind==='live'||kind==='hls')touchSession(partnerId,sessionId,begin);
  const liveKey=kind==='live'&&isUuid(sessionId)?`${partnerId}:${sessionId}`:null;
  if(liveKey)liveSessions.set(liveKey,(liveSessions.get(liveKey)||0)+1);
  const write=res.write,end=res.end;
  function countBytes(chunk,encoding){
    // 302 não transmite a mídia; X-Accel retorna cabeçalhos ao Node, mas o corpo é enviado pelo Nginx.
    if(res.statusCode>=300&&res.statusCode<400)return;
    if(res.getHeader?.('X-Accel-Redirect'))return;
    const size=byteLen(chunk,encoding);
    if(size)add({partnerId,deviceId,kind,transport:'node',bytes:size});
  }
  res.write=function(chunk,encoding){countBytes(chunk,encoding);return write.apply(this,arguments);};
  res.end=function(chunk,encoding){countBytes(chunk,encoding);return end.apply(this,arguments);};
  const finish=()=>{
    if(closed)return;closed=true;
    if(liveKey){const n=liveSessions.get(liveKey)||0;if(n<=1)liveSessions.delete(liveKey);else liveSessions.set(liveKey,n-1);}
    const transport=res.getHeader?.('X-Accel-Redirect')?'nginx_unmetered':res.statusCode>=300&&res.statusCode<400?'redirect':'node';
    add({partnerId,deviceId,kind,transport,requests:1,errors:res.statusCode>=400?1:0,durationMs:Math.max(0,Date.now()-begin)});
  };
  res.once('finish',finish);res.once('close',finish);
  return res;
}

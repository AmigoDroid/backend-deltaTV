import { verifyJwt } from '../../shared/crypto.js';
import { DeviceSession } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { readAudit, observe, ipFamily } from './service.js';
import { livePlayback } from '../../realtime/live-snapshot.js';
export const auditParams=validate({params:z.object({id:z.string().uuid()}),query:z.object({before:z.string().datetime().optional(),beforeId:z.string().uuid().optional()})});
export const auditRead=partner=>(req,res)=>readAudit(req.valid.params.id,partner?req.user.partnerId:null,req.valid.query.before,req.valid.query.beforeId).then(data=>res.set('Cache-Control','no-store').json(data));
export const telemetrySchema=z.object({
 state:z.enum(['opening','playing','buffering','paused','error','finished','stopped']),
 origin:z.string().max(512).optional(), playback_id:z.string().uuid(),
 position:z.number().int().min(0).max(2147483647).optional(),
 error_code:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),build:z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).optional(),
 title:z.string().max(140).optional(),kind:z.enum(['live','movie','series','unknown']).optional(),
 duration:z.number().int().min(0).max(2147483647).optional(),
 bitrate_kbps:z.number().int().min(0).max(100000).optional(),
 startup_ms:z.number().int().min(0).max(600000).optional(),
 buffer_percent:z.number().int().min(0).max(100).optional()
}).strict();
export const telemetryValidate=validate({body:telemetrySchema});
export async function telemetry(req,res){
 if(req.device.session.expiresAt < new Date())throw new AppError(401,'SESSION_EXPIRED','Sessão encerrada.');
 const b=req.valid.body;
 livePlayback(req.device.activation.id, b, req.ip);
 observe({activationId:req.device.activation.id,sessionId:req.device.session.id,source:'tv',state:b.state,clientFamily:ipFamily(req.ip),
 origin:b.origin,playbackId:b.playback_id,position:b.position,errorCode:b.error_code,build:b.build});
 res.set('Cache-Control','no-store').json({ok:true});
}

// Telemetria não precisa consultar licenças, faturas e catálogo a cada sinal de vida.
export async function requireTelemetry(req,_res,next){
 const authorization=req.get('authorization')||'';
 const payload=verifyJwt(authorization.startsWith('Bearer ')?authorization.slice(7):null,'telemetry');
 const session=await DeviceSession.findByPk(payload.sid,{attributes:['id','activationId','revokedAt','expiresAt']});
 if(!session || session.revokedAt || session.activationId!==payload.aid || session.expiresAt<=new Date())throw new AppError(401,'SESSION_REVOKED','Sessão encerrada.');
 req.device={activation:{id:session.activationId},session};
 next();
}

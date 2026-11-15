import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { sequelize, Partner } from '../../db/models/index.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireDevice } from '../access/access.middleware.js';
import { effectivePartnerStatus } from '../access/access.policy.js';
import { validate } from '../../shared/validate.js';
import { AppError } from '../../shared/errors.js';
import { audit, actorOf } from '../../shared/audit.js';
import { messageScope, OWNERSHIP_JOINS, OWNERSHIP_WHERE } from './policy.js';
const select = (sql, replacements, transaction) => sequelize.query(sql,{replacements,transaction,type:QueryTypes.SELECT});
const idSchema = z.object({id:z.string().uuid()});
const audienceSchema = z.object({audience:z.enum(['all','selected']), deviceIds:z.array(z.string().uuid()).max(500).default([])}).superRefine((v,ctx)=>{
 if(v.audience==='selected'&&!v.deviceIds.length) ctx.addIssue({code:'custom',message:'Selecione pelo menos uma TV.',path:['deviceIds']});
});
const sendSchema = z.object({audience:z.enum(['all','selected']),deviceIds:z.array(z.string().uuid()).max(500).default([]),
 title:z.string().trim().min(3).max(100),message:z.string().trim().min(3).max(1200),
 expiresInDays:z.number().int().min(1).max(30),requestId:z.string().uuid()});
const targetSQL = `${OWNERSHIP_JOINS} WHERE ${OWNERSHIP_WHERE}
 AND (:all OR a.device_id IN (:ids))`;
function target(req, body) {
 if(body.audience==='selected'&&!body.deviceIds.length) throw new AppError(400,'NO_RECIPIENTS','Selecione pelo menos uma TV.');
 return {...req.messageScope,all:body.audience==='all',ids:[...new Set(body.deviceIds)].length?[...new Set(body.deviceIds)]:[null]};
}
export const panelMessages = Router();
panelMessages.use(authenticate, async (req,res,next)=>{
 if(req.user.role==='partner' && req.user.permissionRoleId && !req.user.permissions?.includes(`partner:messages:${['GET','HEAD'].includes(req.method)?'read':'write'}`))throw new AppError(403,'FORBIDDEN','Seu papel não permite esta ação.');
 const scope=messageScope(req.user);
 if(!scope) throw new AppError(403,'FORBIDDEN','Acesso restrito ao superadmin e parceiros.');
 if(!scope.global) {
  const p=await Partner.findByPk(scope.partner);
  if(!p||effectivePartnerStatus(p)!=='active') throw new AppError(403,'PARTNER_INACTIVE','Sua conta precisa estar ativa para enviar mensagens.');
 }
 req.messageScope=scope;res.set('Cache-Control','no-store');next();
});
panelMessages.get('/recipients',validate({query:z.object({q:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)})}),async(req,res)=>{
 const {q,page}=req.valid.query;
 const r={...req.messageScope,q:`%${q.replace(/[\\%_]/g,'\\$&')}%`,offset:(page-1)*20};
 const where=`${OWNERSHIP_JOINS} WHERE ${OWNERSHIP_WHERE} AND (a.mac ILIKE :q OR a.playlist_name ILIKE :q)`;
 const [data,counts]=await Promise.all([select(`SELECT DISTINCT ON(a.device_id) a.device_id AS id,a.mac,a.playlist_name AS name ${where} ORDER BY a.device_id,a.id LIMIT 20 OFFSET :offset`,r),select(`SELECT COUNT(DISTINCT a.device_id)::int total ${where}`,r)]);
 res.json({data,total:counts[0].total,page});
});
panelMessages.post('/preview',validate({body:audienceSchema}),async(req,res)=>{
 const r=target(req,req.valid.body);
 const [{total}]=await select(`SELECT COUNT(DISTINCT a.device_id)::int total ${targetSQL}`,r);
 if(!r.all&&total!==r.ids.length) throw new AppError(403,'INVALID_RECIPIENTS','Há TVs indisponíveis ou fora da sua carteira. Atualize a seleção.');
 res.json({total});
});
panelMessages.post('/',rateLimit({windowMs:60000,limit:6,keyGenerator:req=>req.user.id,standardHeaders:'draft-7',legacyHeaders:false}),validate({body:sendSchema}),async(req,res)=>{
 const b=req.valid.body,r=target(req,b),hash=createHash('sha256').update(JSON.stringify({...b,deviceIds:[...new Set(b.deviceIds)].sort()})).digest('hex');
 const result=await sequelize.transaction(async transaction=>{
  // Serializa retries inclusive entre processos; a restrição UNIQUE também protege a persistência.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key,0))',{replacements:{key:req.user.id+':'+b.requestId},transaction});
  const [old]=await select('SELECT id,payload_hash FROM tv_message_campaigns WHERE sender_id=:sender AND request_id=:request',{sender:req.user.id,request:b.requestId},transaction);
  if(old) {
   if(old.payload_hash!==hash) throw new AppError(409,'REQUEST_CONFLICT','Este envio já foi usado com outro conteúdo.');
   const [{total}]=await select('SELECT COUNT(*)::int total FROM tv_message_deliveries WHERE campaign_id=:id',{id:old.id},transaction);
   return {id:old.id,total,reused:true};
  }
  const id=randomUUID();
  await sequelize.query(`INSERT INTO tv_message_campaigns(id,sender_id,partner_id,request_id,payload_hash,title,message,expires_at)
   VALUES(:id,:sender,:partner,:request,:hash,:title,:message,NOW()+(:days * INTERVAL '1 day'))`,{transaction,replacements:{id,sender:req.user.id,partner:r.partner,request:b.requestId,hash,title:b.title,message:b.message,days:b.expiresInDays}});
  const [{total}]=await select(`WITH inserted AS (INSERT INTO tv_message_deliveries(campaign_id,device_id,activation_id)
   SELECT DISTINCT ON(a.device_id) :id,a.device_id,a.id ${targetSQL} ORDER BY a.device_id,a.id RETURNING device_id) SELECT COUNT(*)::int total FROM inserted`,{...r,id},transaction);
  if(!r.all&&total!==r.ids.length) throw new AppError(403,'INVALID_RECIPIENTS','Há TVs indisponíveis ou fora da sua carteira.');
  if(!total) throw new AppError(400,'NO_RECIPIENTS','Nenhuma TV disponível para este envio.');
  await audit({actor:actorOf(req),action:'tv.message.created',entityType:'tv_message_campaign',entityId:id,metadata:{total,audience:b.audience},transaction});
  return {id,total,reused:false};
 });
 res.status(result.reused?200:201).json(result);
});
panelMessages.get('/',validate({query:z.object({page:z.coerce.number().int().min(1).max(100000).default(1)})}),async(req,res)=>{
 const r={...req.messageScope,offset:(req.valid.query.page-1)*20};
 const data=await select(`SELECT c.id,c.sender_id,c.partner_id,c.request_id,c.payload_hash,c.title,c.message,c.created_at,c.expires_at,c.cancelled_at,COUNT(d.device_id)::int total,COUNT(d.read_at)::int read
 FROM (SELECT * FROM tv_message_campaigns WHERE (:global OR partner_id=:partner) ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET :offset) c
 LEFT JOIN tv_message_deliveries d ON d.campaign_id=c.id GROUP BY c.id,c.sender_id,c.partner_id,c.request_id,c.payload_hash,c.title,c.message,c.created_at,c.expires_at,c.cancelled_at ORDER BY c.created_at DESC,c.id DESC`,r);
 res.json({data:data.map(({payload_hash,request_id,...row})=>row)});
});
panelMessages.post('/:id/cancel',validate({params:idSchema}),async(req,res)=>{
 await sequelize.transaction(async transaction=>{
  const rows=await select(`UPDATE tv_message_campaigns SET cancelled_at=COALESCE(cancelled_at,NOW())
   WHERE id=:id AND (:global OR partner_id=:partner) RETURNING id`,{...req.messageScope,id:req.valid.params.id},transaction);
  if(!rows.length) throw new AppError(404,'NOT_FOUND','Mensagem não encontrada.');
  await audit({actor:actorOf(req),action:'tv.message.cancelled',entityType:'tv_message_campaign',entityId:req.valid.params.id,transaction});
 });res.json({ok:true});
});
// Sessão da TV é obrigatória. Nunca aceita MAC/UUID público como credencial.
export const clientMessages=Router();
clientMessages.use(requireDevice('device',{enforce:false}));
const INBOX=`FROM tv_message_deliveries d JOIN tv_message_campaigns c ON c.id=d.campaign_id
 JOIN activations a ON a.id=d.activation_id
 LEFT JOIN licenses g ON g.id=a.granted_license_id LEFT JOIN licenses l ON l.id=a.license_id
 WHERE d.device_id=:device AND a.status <> 'revoked' AND c.cancelled_at IS NULL AND c.expires_at>NOW()
 AND (c.partner_id IS NULL OR a.partner_id=c.partner_id OR COALESCE(g.owner_partner_id,l.owner_partner_id)=c.partner_id)`;
clientMessages.get('/',async(req,res)=>{
 const data=await select(`SELECT c.id,c.title,c.message,c.expires_at AS "expiresAt" ${INBOX} AND d.read_at IS NULL ORDER BY c.created_at,c.id LIMIT 20`,{device:req.device.activation.deviceId});
 res.set('Cache-Control','no-store').json({data,pollAfterSeconds:60});
});
clientMessages.post('/:id/read',validate({params:idSchema}),async(req,res)=>{
 const r={id:req.valid.params.id,device:req.device.activation.deviceId};
 const rows=await select(`UPDATE tv_message_deliveries SET read_at=COALESCE(read_at,NOW())
 WHERE device_id=:device AND campaign_id=:id AND campaign_id IN(SELECT c.id ${INBOX} AND c.id=:id) RETURNING campaign_id`,r);
 if(!rows.length) throw new AppError(404,'NOT_FOUND','Mensagem indisponível.');
 res.set('Cache-Control','no-store').json({ok:true});
});

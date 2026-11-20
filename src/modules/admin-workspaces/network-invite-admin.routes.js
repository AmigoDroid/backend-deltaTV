import {Router} from 'express';
import {z} from 'zod';
import {randomBytes,createHash} from 'node:crypto';
import {Op} from 'sequelize';
import {sequelize,AdminNetworkInvitation,AdminNetworkInviteRedemption,AdminUser,ServicePlanCatalog} from '../../db/models/index.js';
import {AppError} from '../../shared/errors.js';
import {audit,actorOf} from '../../shared/audit.js';
import {validate} from '../../shared/validate.js';
import {adminHasNetworkPermission} from './permissions.js';
import {scopedPlan} from './account-provisioning.js';
import {planFingerprint} from './plan-entitlements.js';
import {assertPublicPlan} from '../service-plans/network-plan-visibility.js';
import {sendMail} from '../mail/mail.transport.js';
import {env} from '../../config/env.js';
import {remainingUses} from './network-invite.policy.js';

const router=Router();
const HASH=token=>createHash('sha256').update(token).digest('hex');
const body=z.object({
 email:z.union([z.string().trim().email().max(200),z.literal('')]).optional(),
 kind:z.enum(["content","reseller"]).default("content"),
 planKey:z.string().min(3).max(32),
 sendEmail:z.boolean().default(false),
 label:z.string().trim().max(120).optional(),
 validityDays:z.number().int().min(1).max(90).default(7),
 maxUses:z.number().int().min(1).max(1000).nullable().optional(),
}).strict().superRefine((v,ctx)=>{
 if(v.sendEmail&&!v.email)ctx.addIssue({code:'custom',path:['email'],message:'Informe o destinatário para enviar por e-mail.'});
 if(v.email&&v.maxUses!==undefined&&v.maxUses!==1)ctx.addIssue({code:'custom',path:['maxUses'],message:'Convite pessoal só pode ser usado uma vez.'});
});
function canInvite(req,kind){
 const permission=kind==='reseller'?'network:resellers:write':'network:partners:write';
 if(!adminHasNetworkPermission(req.user,permission))
  throw new AppError(403,'NETWORK_PERMISSION_DENIED','A DeltaTV não autorizou convites para este tipo de conta.');
}
function needWrite(req){
 if(!adminHasNetworkPermission(req.user,'network:partners:write')&&
    !adminHasNetworkPermission(req.user,'network:resellers:write'))
  throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sua rede não pode convidar parceiros ou revendas.');
}
// Quem pode convidar precisa escolher um plano, mesmo sem acesso à edição de planos.
router.get('/plans',async(req,res)=>{
 needWrite(req);
 const audiences=[];
 if(adminHasNetworkPermission(req.user,'network:partners:write'))audiences.push('content');
 if(adminHasNetworkPermission(req.user,'network:resellers:write'))audiences.push('reseller');
 audiences.push('both');
 const rows=await ServicePlanCatalog.findAll({where:{ownerAdminId:req.networkOwnerId,active:true,hiddenFromNetwork:false,deletedAt:null,
   audience:{[Op.in]:audiences}},attributes:['key','name','audience','monthlyPriceCents','maxServers','activationLimit','validityDays'],
   order:[['name','ASC']]});
 res.set('Cache-Control','no-store').json({data:rows});
});
router.get('/',validate({query:z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)})}),async(req,res)=>{
 needWrite(req);
 const {page,pageSize}=req.valid.query;
 const allowedKinds=[
  ...(adminHasNetworkPermission(req.user,'network:partners:write')?['content']:[]),
  ...(adminHasNetworkPermission(req.user,'network:resellers:write')?['reseller']:[]),
 ];
 const {rows,count}=await AdminNetworkInvitation.findAndCountAll({where:{ownerAdminId:req.networkOwnerId,deletedAt:null,kind:{[Op.in]:allowedKinds}},
   attributes:['id','email','kind','label','planKey','expiresAt','acceptedAt','revokedAt','partnerId','createdAt','maxUses','useCount','lastUsedAt'],
   order:[['createdAt','DESC']],limit:pageSize,offset:(page-1)*pageSize});
 res.set('Cache-Control','no-store').json({data:rows.map(r=>({...r.toJSON(),remainingUses:remainingUses(r)})),meta:{page,pageSize,total:count,totalPages:Math.ceil(count/pageSize)}});
});
router.post('/',validate({body}),async(req,res)=>{
 needWrite(req);
 const b=req.valid.body;canInvite(req,b.kind);
 const ownerId=req.networkOwnerId,email=b.email?.trim().toLowerCase()||null;
 if(email){
  const exists=await AdminUser.findOne({where:{email:{[Op.iLike]:email},deletedAt:null},attributes:['id']});
  if(exists)throw new AppError(409,'EMAIL_IN_USE','E-mail já cadastrado. Edite a conta existente.');
 }
 const token=randomBytes(32).toString('base64url');
 const invitation=await sequelize.transaction(async transaction=>{
  const plan=assertPublicPlan(await scopedPlan(ownerId,b.planKey,b.kind,transaction));
  const row=await AdminNetworkInvitation.create({ownerAdminId:ownerId,invitedById:req.user.id,email,kind:b.kind,
    planKey:plan.key,planFingerprint:planFingerprint(plan),tokenHash:HASH(token),
    label:b.label?.trim()||null,maxUses:email?1:(b.maxUses===undefined?10:b.maxUses),useCount:0,
    expiresAt:new Date(Date.now()+b.validityDays*86400_000)}, {transaction});
  await audit({actor:actorOf(req),action:'network.invite.create',entityType:'network_invitation',entityId:row.id,
    metadata:{ownerAdminId:ownerId,kind:b.kind,planKey:plan.key,recipientEmail:email,maxUses:email?1:(b.maxUses===undefined?10:b.maxUses)},transaction});
  return row;
 });
 const url=`${env.partnerPortalUrl}/convite-rede/${encodeURIComponent(token)}`;
 let emailSent=false,warning;
 if(b.sendEmail){
  try{
   // Falha de SMTP não invalida o link gerado: Admin pode copiá-lo e enviar manualmente.
   await sendMail({to:email,subject:`DeltaTV — convite para ${b.kind==='reseller'?'Revenda':'Parceiro'}`,
    text:`Você foi convidado para criar uma conta ${b.kind==='reseller'?'de Revenda':'do Painel do Parceiro'} DeltaTV.\n\nAbra o link até ${invitation.expiresAt.toLocaleString('pt-BR')}:\n${url}\n\nSe não esperava este convite, ignore.`,
   }); emailSent=true;
  }catch(error){warning='E-mail não enviado. Copie e encaminhe o link manualmente.';}
 }
 res.status(201).set('Cache-Control','no-store').json({id:invitation.id,url,expiresAt:invitation.expiresAt,kind:b.kind,maxUses:invitation.maxUses,emailSent,...(warning?{warning}:{})});
});
router.get('/:id/registrations',validate({params:z.object({id:z.string().uuid()}),
 query:z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)})}),async(req,res)=>{
 needWrite(req);
 const row=await AdminNetworkInvitation.findOne({where:{id:req.valid.params.id,ownerAdminId:req.networkOwnerId,deletedAt:null},attributes:['id','kind']});
 if(!row)throw new AppError(404,'NOT_FOUND','Link não encontrado nesta rede.');
 canInvite(req,row.kind);
 const {page,pageSize}=req.valid.query;
 const {rows,count}=await AdminNetworkInviteRedemption.findAndCountAll({where:{invitationId:row.id},
  attributes:['partnerId','email','createdAt'],order:[['createdAt','DESC']],limit:pageSize,offset:(page-1)*pageSize});
 res.set('Cache-Control','no-store').json({data:rows,meta:{page,pageSize,total:count,totalPages:Math.ceil(count/pageSize)}});
});
router.post('/:id/revoke',validate({params:z.object({id:z.string().uuid()})}),async(req,res)=>{
 needWrite(req);
 await sequelize.transaction(async t=>{
  const invite=await AdminNetworkInvitation.findOne({where:{id:req.valid.params.id,ownerAdminId:req.networkOwnerId,deletedAt:null},transaction:t,lock:t.LOCK.UPDATE});
  if(!invite)throw new AppError(404,'NOT_FOUND','Convite não encontrado nesta rede.');
  canInvite(req,invite.kind);
  if(invite.acceptedAt || (invite.maxUses!==null && invite.useCount >= invite.maxUses))throw new AppError(409,'ALREADY_USED','Convite sem usos restantes.');
  await invite.update({revokedAt:new Date()},{transaction:t});
  await audit({actor:actorOf(req),action:'network.invite.revoke',entityType:'network_invitation',entityId:invite.id,transaction:t});
 });res.json({ok:true});
});
// O token antigo nunca é retornado: apenas um novo token pode ser entregue ao Admin.
const inviteId=z.object({id:z.string().uuid()});
const changes=z.object({label:z.string().trim().max(120).nullable().optional(),validityDays:z.number().int().min(1).max(90).optional(),maxUses:z.number().int().min(1).max(1000).nullable().optional()}).strict().refine(v=>Object.keys(v).length>0,'Informe uma alteração.');
async function lockedInvite(req,t){
 const row=await AdminNetworkInvitation.findOne({where:{id:req.valid.params.id,ownerAdminId:req.networkOwnerId,deletedAt:null},transaction:t,lock:t.LOCK.UPDATE});
 if(!row)throw new AppError(404,'NOT_FOUND','Convite não encontrado nesta rede.');
 canInvite(req,row.kind);return row;
}
router.patch('/:id',validate({params:inviteId,body:changes}),async(req,res)=>{
 needWrite(req);
 const result=await sequelize.transaction(async t=>{
  const row=await lockedInvite(req,t);
  if(row.revokedAt||new Date(row.expiresAt)<=new Date())throw new AppError(409,'INVITE_INACTIVE','Link encerrado: crie outro convite.');
  const b=req.valid.body;
  if(b.maxUses!==undefined&&(b.maxUses!==null&&b.maxUses<row.useCount||row.email&&b.maxUses!==1))throw new AppError(422,'INVALID_MAX_USES','Quantidade incompatível com os usos realizados ou com convite pessoal.');
  const updates={};if(b.label!==undefined)updates.label=b.label||null;
  if(b.maxUses!==undefined)updates.maxUses=b.maxUses;
  if(b.validityDays!==undefined)updates.expiresAt=new Date(Date.now()+b.validityDays*86400_000);
  await row.update(updates,{transaction:t});
  await audit({actor:actorOf(req),action:'network.invite.update',entityType:'network_invitation',entityId:row.id,metadata:{fields:Object.keys(updates)},transaction:t});
  return {ok:true};
 });res.json(result);
});
router.post('/:id/rotate',validate({params:inviteId}),async(req,res)=>{
 needWrite(req);const token=randomBytes(32).toString('base64url');
 await sequelize.transaction(async t=>{
  const row=await lockedInvite(req,t);
  if(row.revokedAt||new Date(row.expiresAt)<=new Date()||(row.maxUses!==null&&row.useCount>=row.maxUses))throw new AppError(409,'INVITE_INACTIVE','Este convite não aceita novos cadastros.');
  await row.update({tokenHash:HASH(token)},{transaction:t});
  await audit({actor:actorOf(req),action:'network.invite.rotate',entityType:'network_invitation',entityId:row.id,transaction:t});
 });
 res.set('Cache-Control','no-store').json({url:`${env.partnerPortalUrl}/convite-rede/${encodeURIComponent(token)}`});
});
router.delete('/:id',validate({params:inviteId}),async(req,res)=>{
 needWrite(req);
 await sequelize.transaction(async t=>{
  const row=await lockedInvite(req,t);
  await row.update({deletedAt:new Date(),revokedAt:row.revokedAt||new Date()},{transaction:t});
  await audit({actor:actorOf(req),action:'network.invite.delete',entityType:'network_invitation',entityId:row.id,metadata:{usedCount:row.useCount},transaction:t});
 });res.json({ok:true});
});
export default router;

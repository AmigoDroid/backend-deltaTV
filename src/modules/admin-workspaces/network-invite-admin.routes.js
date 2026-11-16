import {Router} from 'express';
import {z} from 'zod';
import {randomBytes,createHash} from 'node:crypto';
import {Op} from 'sequelize';
import {sequelize,AdminNetworkInvitation,AdminUser} from '../../db/models/index.js';
import {AppError} from '../../shared/errors.js';
import {audit,actorOf} from '../../shared/audit.js';
import {validate} from '../../shared/validate.js';
import {adminHasNetworkPermission} from './permissions.js';
import {scopedPlan} from './account-provisioning.js';
import {planFingerprint} from './plan-entitlements.js';
import {sendMail} from '../mail/mail.transport.js';
import {env} from '../../config/env.js';

const router=Router();
const HASH=token=>createHash('sha256').update(token).digest('hex');
const body=z.object({email:z.string().trim().email().max(200),planKey:z.string().min(3).max(32),sendEmail:z.boolean().default(false)}).strict();
function needWrite(req){
 if(!adminHasNetworkPermission(req.user,'network:partners:write'))
  throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sua rede não pode cadastrar parceiros.');
}
router.get('/',async(req,res)=>{
 needWrite(req);
 const rows=await AdminNetworkInvitation.findAll({where:{ownerAdminId:req.networkOwnerId},
   attributes:['id','email','planKey','expiresAt','acceptedAt','revokedAt','partnerId','createdAt'],
   order:[['createdAt','DESC']],limit:60});
 res.set('Cache-Control','no-store').json({data:rows});
});
router.post('/',validate({body}),async(req,res)=>{
 needWrite(req);
 const ownerId=req.networkOwnerId, b=req.valid.body,email=b.email.toLowerCase();
 const exists=await AdminUser.findOne({where:{email:{[Op.iLike]:email},deletedAt:null},attributes:['id']});
 if(exists)throw new AppError(409,'EMAIL_IN_USE','E-mail já cadastrado. Edite a conta existente.');
 const token=randomBytes(32).toString('base64url');
 const invitation=await sequelize.transaction(async transaction=>{
  const plan=await scopedPlan(ownerId,b.planKey,'content',transaction);
  const row=await AdminNetworkInvitation.create({ownerAdminId:ownerId,invitedById:req.user.id,email,
    planKey:plan.key,planFingerprint:planFingerprint(plan),tokenHash:HASH(token),
    expiresAt:new Date(Date.now()+72*3600_000)}, {transaction});
  await audit({actor:actorOf(req),action:'network.invite.create',entityType:'network_invitation',entityId:row.id,
    metadata:{ownerAdminId:ownerId,planKey:plan.key,recipientEmail:email},transaction});
  return row;
 });
 const url=`${env.partnerPortalUrl}/convite-rede/${encodeURIComponent(token)}`;
 let emailSent=false,warning;
 if(b.sendEmail){
  try{
   // Falha de SMTP não invalida o link gerado: Admin pode copiá-lo e enviar manualmente.
   await sendMail({to:email,subject:'DeltaTV — convite para seu Painel do Parceiro',
    text:`Você foi convidado para criar uma conta no Painel do Parceiro DeltaTV.\n\nAbra o link dentro de 72 horas:\n${url}\n\nSe não esperava este convite, ignore.`,
   }); emailSent=true;
  }catch(error){warning='E-mail não enviado. Copie e encaminhe o link manualmente.';}
 }
 res.status(201).set('Cache-Control','no-store').json({id:invitation.id,url,expiresAt:invitation.expiresAt,emailSent,...(warning?{warning}:{})});
});
router.post('/:id/revoke',validate({params:z.object({id:z.string().uuid()})}),async(req,res)=>{
 needWrite(req);
 await sequelize.transaction(async t=>{
  const invite=await AdminNetworkInvitation.findOne({where:{id:req.valid.params.id,ownerAdminId:req.networkOwnerId},transaction:t,lock:t.LOCK.UPDATE});
  if(!invite)throw new AppError(404,'NOT_FOUND','Convite não encontrado nesta rede.');
  if(invite.acceptedAt)throw new AppError(409,'ALREADY_USED','Convite já utilizado.');
  await invite.update({revokedAt:new Date()},{transaction:t});
  await audit({actor:actorOf(req),action:'network.invite.revoke',entityType:'network_invitation',entityId:invite.id,transaction:t});
 });res.json({ok:true});
});
export default router;

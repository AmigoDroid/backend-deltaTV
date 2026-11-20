import {Router} from 'express';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {Op} from 'sequelize';
import {sequelize,AdminNetworkInvitation,AdminNetworkInviteRedemption,AdminUser,Partner,ServicePlanCatalog} from '../../db/models/index.js';
import {validate} from '../../shared/validate.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
import {hashPassword} from '../../shared/crypto.js';
import {normalizeNetworkPermissions,normalizeNetworkLimits} from './permissions.js';
import {provisionNetworkAccount,scopedPlan,lockNetworkOwner,checkPlanCaps} from './account-provisioning.js';
import {planFingerprint} from './plan-entitlements.js';
import {assertPublicPlan} from '../service-plans/network-plan-visibility.js';
import {invalidatePlan} from '../service-plans/plan.service.js';
import {clearContractAccessCache} from '../access/access.service.js';
import {invalidateServerPools} from '../provider-monitor/code-pool.service.js';
import {clearResolutionCache} from '../provider-monitor/resolve.service.js';
import {inviteVerifyLimiter,inviteCompleteLimiter} from '../../middleware/security.js';
import {inviteUnavailable,inviteRecipient,remainingUses} from './network-invite.policy.js';

const router=Router();
const token=z.string().min(32).max(100).regex(/^[A-Za-z0-9_-]+$/);
const HASH=t=>createHash('sha256').update(t).digest('hex');
function assertValid(row){
 if(inviteUnavailable(row))
  throw new AppError(410,'INVITE_UNAVAILABLE','Convite expirado, revogado ou já utilizado.');
}
async function ownerAllowed(row,transaction){
 if(row.ownerAdminId===null){
   const issuer=await AdminUser.findOne({where:{id:row.invitedById,role:'superadmin',status:'active',deletedAt:null},transaction});
   if(!issuer)throw new AppError(403,'INVITER_NOT_AUTHORIZED','Convite da DeltaTV sem autorização.');
   return {networkLimits:{}};
 }
 const user=await AdminUser.findOne({where:{id:row.ownerAdminId,role:'admin',status:'active',deletedAt:null},transaction});
 if(!user||!normalizeNetworkPermissions(user.delegatedPermissions).includes(row.kind==='reseller'?'network:resellers:write':'network:partners:write'))
  throw new AppError(403,'INVITER_NOT_AUTHORIZED','A rede deste convite não está habilitada para novos cadastros.');
 return user;
}
router.post('/verify',inviteVerifyLimiter,validate({body:z.object({token}).strict()}),async(req,res)=>{
 const r=await AdminNetworkInvitation.findOne({where:{tokenHash:HASH(req.valid.body.token)}});
 assertValid(r);
 await ownerAllowed(r);
 const plan=assertPublicPlan(await scopedPlan(r.ownerAdminId,r.planKey,r.kind));
 if(r.planFingerprint!==planFingerprint(plan))throw new AppError(409,'PLAN_CHANGED','Este plano foi alterado; solicite novo convite.');
 res.set('Cache-Control','no-store').json({email:r.email||null,kind:r.kind,remainingUses:remainingUses(r),planName:plan.name,monthlyFeeCents:plan.monthlyPriceCents,
   maxDns:plan.maxServers,activationLimit:plan.activationLimit,expiresAt:r.expiresAt});
});
router.post('/complete',inviteCompleteLimiter,validate({body:z.object({token,name:z.string().trim().min(2).max(160),email:z.string().trim().email().max(200).optional(),password:z.string().min(12).max(128)}).strict()}),async(req,res)=>{
 const b=req.valid.body;
 const passwordHash=await hashPassword(b.password); // custo de CPU fora da transação
 const result=await sequelize.transaction(async t=>{
  const r=await AdminNetworkInvitation.findOne({where:{tokenHash:HASH(b.token)},transaction:t,lock:t.LOCK.UPDATE});
  assertValid(r);
  // Evita duas conclusões concorrentes e serializa cadastros na rede.
  await lockNetworkOwner(r.ownerAdminId,t);
  const owner=await ownerAllowed(r,t);
  const plan=assertPublicPlan(await scopedPlan(r.ownerAdminId,r.planKey,r.kind,t));
  if(planFingerprint(plan)!==r.planFingerprint)throw new AppError(409,'PLAN_CHANGED','Plano alterado após o convite. Peça outro link.');
  const email=inviteRecipient(r,b.email);
  if(!email || !z.string().email().max(200).safeParse(email).success)
   throw new AppError(422,'EMAIL_REQUIRED','Informe um e-mail válido para o cadastro.');
  const exists=await AdminUser.findOne({where:{email:{[Op.iLike]:email},deletedAt:null},transaction:t});
  if(exists)throw new AppError(409,'EMAIL_IN_USE','Esta conta já existe. Entre pelo seu e-mail.');
  const account=await provisionNetworkAccount({ownerId:r.ownerAdminId,
    actor:{type:'anonymous',id:null},plan,name:b.name,email,passwordHash,
    kind:r.kind,limits:normalizeNetworkLimits(owner.networkLimits),transaction:t});
  const nextCount=(r.useCount||0)+1;
  const finalUse=r.maxUses!==null && nextCount>=r.maxUses;
  await r.update({useCount:nextCount,lastUsedAt:new Date(),
   ...(finalUse?{acceptedAt:new Date(),partnerId:r.maxUses===1?account.partner.id:null}:{})},{transaction:t});
  await AdminNetworkInviteRedemption.create({invitationId:r.id,partnerId:account.partner.id,email},{transaction:t});
  await audit({actor:{type:'anonymous',id:null},action:'network.invite.accept',entityType:'network_invitation',entityId:r.id,
   metadata:{ownerAdminId:r.ownerAdminId,partnerId:account.partner.id,planKey:plan.key,kind:r.kind,useNumber:nextCount},transaction:t});
  return {partnerId:account.partner.id,status:account.partner.status};
 });
 invalidatePlan(result.partnerId);invalidateServerPools();clearResolutionCache();clearContractAccessCache();
 res.set('Cache-Control','no-store').status(201).json({ok:true,status:result.status});
});
export default router;

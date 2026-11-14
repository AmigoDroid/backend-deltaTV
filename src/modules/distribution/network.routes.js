import { effectiveResources, directResources, setResource, NETWORK_RESOURCES } from "./network.resources.js";
import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { stockWriteLimiter, signupLimiter } from "../../middleware/security.js";
import { actorOf } from "../../shared/audit.js";
import { AppError, notFound } from "../../shared/errors.js";
import { Partner } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import * as net from "./network.service.js";

const uuid = z.string().uuid();
const paramsId = z.object({ id: uuid });
const flags = z.object({
  canInvite: z.boolean(), canSell: z.boolean(), canPromote: z.boolean(),
  maxChildren: z.number().int().min(0).nullable().default(null), maxDepth: z.number().int().min(1).nullable().default(null),
}).strict();
const offer = z.object({ months:z.number().int().min(1).max(120),priceCredits:z.number().int().min(1).max(2_147_483_647),active:z.boolean().default(true) }).strict();
const resourceBody=z.object({resource:z.enum(NETWORK_RESOURCES),enabled:z.boolean(),limit:z.number().int().min(0).max(2_147_483_647).nullable().default(null)}).strict();

const inviteToken=z.string().min(32).max(120).regex(/^[A-Za-z0-9_-]+$/);
export const adminNetwork = Router();
adminNetwork.get("/",requirePermission("partners:read"),
  validate({query:z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(200).default(100),q:z.string().trim().max(80).optional()})}),
  async(req,res)=>res.set("Cache-Control","no-store").json(await net.networkTree(null,req.valid.query)));
adminNetwork.get("/accounts/:id",requirePermission("partners:read"),validate({params:paramsId}),async(req,res)=>res.set("Cache-Control","no-store").json(await net.overview(req.valid.params.id)));
adminNetwork.get("/accounts/:id/prices",requirePermission("partners:read"),validate({params:paramsId}),async(req,res)=>
  res.set("Cache-Control","no-store").json({data:await net.listOwnPrices(req.valid.params.id,{adminOverride:true})}));
adminNetwork.get("/accounts/:id/sales",requirePermission("partners:read"),validate({params:paramsId}),async(req,res)=>
  res.set("Cache-Control","no-store").json({data:await net.salesFor(req.valid.params.id)}));
adminNetwork.put("/accounts/:id/prices",requirePermission("partners:write"),
  validate({params:paramsId,body:offer}),async(req,res)=>{
    if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin altera preços de outras contas.");
    res.json(await net.setPrice(req.valid.params.id,req.valid.body,actorOf(req),{adminOverride:true}));
  });
adminNetwork.post("/accounts/:id/master",requirePermission("partners:write"),validate({params:paramsId,body:z.object({enabled:z.boolean(),policy:flags}).strict()}),async(req,res)=>{
  if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin altera a hierarquia e os privilégios comerciais.");
  res.json(await net.setMaster(req.valid.params.id,{master:req.valid.body.enabled,policy:req.valid.body.policy,adminOverride:true},actorOf(req)));
});
// O superadmin pode emitir convites diretamente, sem precisar entrar na conta do Master.
const createInviteInput = z.object({maxUses:z.number().int().min(1).nullable().default(null),daysValid:z.number().int().min(1).nullable().default(null)}).strict();
adminNetwork.get("/accounts/:id/invites",requirePermission("partners:read"),validate({params:paramsId}),async(req,res)=>{
  if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin consulta os convites de outras contas.");
  res.set("Cache-Control","no-store").json({data:await net.listInvites(req.valid.params.id)});
});
adminNetwork.post("/accounts/:id/invites",requirePermission("partners:write"),stockWriteLimiter,
  validate({params:paramsId,body:createInviteInput}),async(req,res)=>{
    if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin cria convites de outras contas.");
    res.status(201).set("Cache-Control","no-store").json(await net.createInvite(req.valid.params.id,req.valid.body,actorOf(req),env.resellerPortalUrl));
  });
adminNetwork.post("/accounts/:id/invites/:inviteId/revoke",requirePermission("partners:write"),stockWriteLimiter,
  validate({params:z.object({id:uuid,inviteId:uuid})}),async(req,res)=>{
    if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin revoga convites de outras contas.");
    await net.revokeInvite(req.valid.params.id,req.valid.params.inviteId,actorOf(req));
    res.status(204).end();
  });
adminNetwork.get("/accounts/:id/resources",requirePermission("partners:read"),validate({params:paramsId}),async(req,res)=>res.json({effective:await effectiveResources(req.valid.params.id),direct:await directResources(req.valid.params.id)}));
adminNetwork.put("/accounts/:id/resources",requirePermission("partners:write"),validate({params:paramsId,body:resourceBody}),async(req,res)=>{
  if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin altera essas permissões.");
  res.json(await setResource({targetId:req.valid.params.id,...req.valid.body},actorOf(req)));
});
adminNetwork.post("/accounts/:id/unlink",requirePermission("partners:write"),validate({params:paramsId}),async(req,res)=>{
  if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin desvincula revendas.");
  res.json(await net.detachReseller(req.valid.params.id,actorOf(req)));
});
adminNetwork.post("/accounts/:id/link",requirePermission("partners:write"),validate({params:paramsId,body:z.object({parentPartnerId:uuid}).strict()}),async(req,res)=>{
  if(req.user.role!=="superadmin") throw new AppError(403,"FORBIDDEN","Somente o superadmin vincula cadastros existentes.");
  res.json(await net.attachReseller(req.valid.params.id,req.valid.body.parentPartnerId,actorOf(req)));
});

export const partnerNetwork = Router();
const ctx = (req) => req.user.partnerId;
partnerNetwork.get("/resources",async(req,res)=>res.json({effective:await effectiveResources(ctx(req)),direct:await directResources(ctx(req))}));
partnerNetwork.get("/children/:id/resources",validate({params:paramsId}),async(req,res)=>{
  const p=await Partner.findByPk(req.valid.params.id);
  if(!p||p.parentPartnerId!==ctx(req)) throw notFound("Revenda desta rede");
  await net.requireMaster(ctx(req),"canInvite");
  res.json({effective:await effectiveResources(p.id),direct:await directResources(p.id)});
});
partnerNetwork.put("/children/:id/resources",stockWriteLimiter,validate({params:paramsId,body:resourceBody}),async(req,res)=>
  res.json(await setResource({targetId:req.valid.params.id,actorParentId:ctx(req),...req.valid.body},actorOf(req))));
partnerNetwork.get("/",validate({query:z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(50)})}),
  async(req,res)=>res.set("Cache-Control","no-store").json(await net.overview(ctx(req),req.valid.query)));
partnerNetwork.get("/prices",async(req,res)=>res.set("Cache-Control","no-store").json({data:await net.listOwnPrices(ctx(req))}));
partnerNetwork.put("/prices",stockWriteLimiter,validate({body:offer}),async(req,res)=>res.json(await net.setPrice(ctx(req),req.valid.body,actorOf(req))));
partnerNetwork.get("/invites",async(req,res)=>res.set("Cache-Control","no-store").json({data:await net.listInvites(ctx(req))}));
partnerNetwork.post("/invites",stockWriteLimiter,validate({body:createInviteInput}),async(req,res)=>
  res.status(201).set("Cache-Control","no-store").json(await net.createInvite(ctx(req),req.valid.body,actorOf(req),env.resellerPortalUrl)));
partnerNetwork.post("/invites/:id/revoke",stockWriteLimiter,validate({params:paramsId}),async(req,res)=>{
  await net.revokeInvite(ctx(req),req.valid.params.id,actorOf(req));res.status(204).end();
});
partnerNetwork.post("/children/:id/approve",stockWriteLimiter,validate({params:paramsId}),async(req,res)=>{
  await net.approveChild(ctx(req),req.valid.params.id,actorOf(req),"approve");res.json({ok:true});
});
partnerNetwork.post("/children/:id/suspend",stockWriteLimiter,validate({params:paramsId}),async(req,res)=>{
  await net.approveChild(ctx(req),req.valid.params.id,actorOf(req),"suspend");res.json({ok:true});
});
partnerNetwork.post("/children/:id/reject",stockWriteLimiter,validate({params:paramsId}),async(req,res)=>{
  await net.approveChild(ctx(req),req.valid.params.id,actorOf(req),"reject");res.json({ok:true});
});
partnerNetwork.post("/children/:id/promote",stockWriteLimiter,
  validate({params:paramsId,body:z.object({policy:flags}).strict()}),async(req,res)=>{
    res.json(await net.setMaster(req.valid.params.id,
      {master:true,policy:req.valid.body.policy,actorParentId:ctx(req)},actorOf(req)));
  });
partnerNetwork.get("/tree",validate({query:z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(200).default(100),q:z.string().trim().max(80).optional()})}),
  async(req,res)=>res.set("Cache-Control","no-store").json(await net.descendantTree(ctx(req),req.valid.query)));
partnerNetwork.get("/summary",async(req,res)=>res.set("Cache-Control","no-store").json(await net.networkSummary(ctx(req))));
partnerNetwork.get("/sales",async(req,res)=>res.set("Cache-Control","no-store").json({data:await net.salesFor(ctx(req))}));
partnerNetwork.get("/purchases",async(req,res)=>res.set("Cache-Control","no-store").json({data:await net.salesFor(ctx(req),{as:"buyer"})}));
// Recover an uncertain checkout after network timeout; scoped to authenticated buyer.
partnerNetwork.get("/purchases/by-key/:id",validate({params:paramsId}),async(req,res)=>
  res.set("Cache-Control","no-store").json({purchase:await net.purchaseByKey(ctx(req),req.valid.params.id)}));
partnerNetwork.post("/buy",stockWriteLimiter,validate({body:z.object({months:z.number().int().min(1).max(120),quantity:z.number().int().min(1).max(2_147_483_647),expectedUnitPriceCredits:z.number().int().min(1).max(2_147_483_647),idempotencyKey:uuid}).strict()}),async(req,res)=>{
  const allowed=await effectiveResources(ctx(req));
  if(!allowed.stock.enabled||!allowed.credits.enabled) throw new AppError(403,"NETWORK_RESOURCE_DISABLED","Estoque ou créditos indisponíveis para sua revenda.");
  res.status(201).set("Cache-Control","no-store").json(await net.networkBuy(ctx(req),req.valid.body,actorOf(req)));
});

export const verifyNetworkInvite=Router();
verifyNetworkInvite.post("/verify",signupLimiter,validate({body:z.object({token:inviteToken}).strict()}),async(req,res)=>
  res.set("Cache-Control","no-store").json(await net.verifyInvite(req.valid.body.token)));

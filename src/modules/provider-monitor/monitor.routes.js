import { auditParams, auditRead } from '../connection-audit/routes.js';
import { Router } from "express";
import { broadcastChange } from "../../realtime/socket.js";
import partnerOperations from "./partner-operations.routes.js";
import { z } from "zod";
import { authenticate,requirePartnerRole } from "../../middleware/authenticate.js";
import { Partner, PartnerCode, Activation, PartnerProvider, ProviderHealthEvent } from "../../db/models/index.js";
import { Op, fn, col } from "sequelize";
import { listCodeServerIds } from "./code-pool.service.js";
import { AppError } from "../../shared/errors.js";
import { validate, partialInput } from "../../shared/validate.js";
import { actorOf } from "../../shared/audit.js";
import { listProviders,createProvider,updateProvider,deleteProvider } from "../providers/provider.service.js";
import * as partners from "../partners/partner.service.js";
import { overview } from "./monitor.service.js";
import * as commerce from "../content-commerce/commerce.service.js";
import * as devices from "../devices/device.service.js";
import { getServicePlan } from "../service-plans/plan.service.js";
import { setCodeServers, invalidateServerPools } from "./code-pool.service.js";
const r=Router();
r.use(authenticate,requirePartnerRole);
r.use(async(req,_res,next)=>{const p=await Partner.findByPk(req.user.partnerId);if(!p|| !["content","both"].includes(p.kind)) throw new AppError(403,"FORBIDDEN","Portal exclusivo de parceiros de conteúdo.");next();});
// Scope realtime invalidations to THIS content partnership; never broadcast to unrelated revendas.
r.use((req,res,next)=>{
  if (["POST","PUT","PATCH","DELETE"].includes(req.method)) res.on("finish",()=>{
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const topic = req.path.split("/").filter(Boolean)[0] || "data";
      broadcastChange({partnerId:req.user.partnerId,topic});
    }
  });
  next();
});
r.use("/", partnerOperations);
r.get("/devices/:id/connection-audit", auditParams, auditRead(true));
r.get("/overview",async(req,res)=>res.set("Cache-Control","no-store").json(await overview(req.user.partnerId)));
r.get("/service-plan",async(req,res)=>res.set("Cache-Control","no-store").json(await getServicePlan(req.user.partnerId)));
r.get("/servers/:id/history",validate({params:z.object({id:z.string().uuid()})}),async(req,res)=>{
  const plan=await getServicePlan(req.user.partnerId);
  if(!plan.features.detailedHistory)throw new AppError(403,"PLAN_HISTORY_REQUIRED","Histórico detalhado disponível no Premium.");
  const provider=await PartnerProvider.findOne({where:{id:req.valid.params.id,partnerId:req.user.partnerId},attributes:["id"]});
  if(!provider)throw new AppError(404,"NOT_FOUND","Servidor não encontrado.");
  const events=await ProviderHealthEvent.findAll({where:{providerId:provider.id},order:[["occurredAt","DESC"]],limit:50,raw:true});
  res.set("Cache-Control","no-store").json({data:events});
});
r.get("/commercial",async(req,res)=>res.set("Cache-Control","no-store").json(await commerce.dashboard(req.user.partnerId)));
r.get("/devices",validate({query:z.object({codeId:z.string().uuid().optional(),q:z.string().max(40).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(50).default(20)})}),
  async(req,res)=>res.set("Cache-Control","no-store").json(await commerce.listDevices(req.user.partnerId,req.valid.query)));
r.post("/devices/:id/revoke",validate({params:z.object({id:z.string().uuid()}),body:z.object({reason:z.string().trim().min(3).max(500)})}),
  async(req,res)=>{await devices.changeActivation(req.valid.params.id,"revoke",{scope:{partnerId:req.user.partnerId},actor:actorOf(req),reason:req.valid.body.reason});res.status(204).end();});
r.post("/codes/:id/credits",validate({params:z.object({id:z.string().uuid()}),body:z.object({quantity:z.number().int().min(-100000).max(100000).refine(n=>n!==0)})}),
  async(req,res)=>res.json(await commerce.allocate(req.user.partnerId,req.valid.params.id,req.valid.body,actorOf(req))));
const srv=z.object({name:z.string().trim().min(2).max(120),baseUrl:z.string().url().max(500),priority:z.number().int().min(0).max(1000).default(0),status:z.enum(["active","disabled"]).default("active")});
// Busca e paginação no banco: milhares de códigos sem carregar tudo no navegador.
r.get("/codes",validate({query:z.object({q:z.string().trim().max(80).optional(),page:z.coerce.number().int().min(1).max(100000).default(1)})}),async(req,res)=>{
  const page=req.valid.query.page;
  const q=(req.valid.query.q||"").replace(/[\\%_]/g,"\\$&");
  const where={partnerId:req.user.partnerId,...(q?{[Op.or]:[{code:{[Op.iLike]:`%${q}%`}},{label:{[Op.iLike]:`%${q}%`}}]}:{})};
  const {rows,count}=await PartnerCode.findAndCountAll({where,attributes:["id","code","label","status","providerId","maxActivations","allowWebIssuance","expiresAt"],order:[["createdAt","DESC"]],limit:25,offset:(page-1)*25});
  const pools=await listCodeServerIds(rows.map(c=>c.id));
  const balances=await commerce.balancesForCodes(rows.map(c=>c.id));
  const activationUsage=rows.length?await (async()=>{
    const grouped=await Activation.findAll({where:{partnerCodeId:{[Op.in]:rows.map(c=>c.id)},status:{[Op.ne]:"revoked"}},
      attributes:["partnerCodeId",[fn("count",col("Activation.id")),"total"]],group:["partnerCodeId"],raw:true});
    return new Map(grouped.map(x=>[x.partnerCodeId,Number(x.total)]));
  })():new Map();
  res.set("Cache-Control","no-store").json({rows:rows.map(c=>({...c.toJSON(),serverIds:pools.get(c.id)||(c.providerId?[c.providerId]:[]),credits:balances.get(c.id)||{allocated:0,spent:0,available:0},activationCount:activationUsage.get(c.id)||0})),count,page,pageSize:25});
});
r.post("/servers",validate({body:srv}),async(req,res)=>res.status(201).json(await createProvider(req.user.partnerId,req.valid.body,actorOf(req),{max:50})));
r.delete("/servers/:id",validate({params:z.object({id:z.string().uuid()})}),async(req,res)=>{await deleteProvider(req.user.partnerId,req.valid.params.id,actorOf(req));res.status(204).end();});
r.patch("/servers/:id",validate({params:z.object({id:z.string().uuid()}),body:partialInput(srv)}),async(req,res)=>res.json(await updateProvider(req.user.partnerId,req.valid.params.id,req.valid.body,actorOf(req))));
r.post("/codes",validate({body:z.object({code:z.string().trim().min(4).max(12).optional(),label:z.string().trim().max(120).optional(),providerId:z.string().uuid()})}),async(req,res)=>res.status(201).json(await partners.createCode(req.user.partnerId,req.valid.body,actorOf(req))));
r.post("/codes/:id/revoke",validate({params:z.object({id:z.string().uuid()})}),async(req,res)=>{await partners.revokeCode(req.user.partnerId,req.valid.params.id,actorOf(req));res.status(204).end();});
r.put("/codes/:id/servers",validate({params:z.object({id:z.string().uuid()}),
  body:z.object({serverIds:z.array(z.string().uuid()).min(1)})}),
  async(req,res)=>res.json(await setCodeServers(req.user.partnerId,req.valid.params.id,req.valid.body.serverIds,actorOf(req))));
r.patch("/codes/:id",validate({params:z.object({id:z.string().uuid()}),body:z.object({providerId:z.string().uuid().optional(),label:z.string().trim().max(120).optional(),maxActivations:z.number().int().min(1).nullable().optional(),allowWebIssuance:z.boolean().optional(),expiresAt:z.coerce.date().nullable().optional()}).refine(b=>Object.keys(b).length>0)}),async(req,res)=>{const result=await partners.updateCode(req.user.partnerId,req.valid.params.id,req.valid.body,actorOf(req));invalidateServerPools(req.valid.params.id);res.json(result)});
export default r;

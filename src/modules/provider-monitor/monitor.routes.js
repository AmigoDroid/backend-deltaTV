import { Router } from "express";
import { z } from "zod";
import { authenticate,requirePartnerRole } from "../../middleware/authenticate.js";
import { Partner, PartnerCode } from "../../db/models/index.js";
import { Op } from "sequelize";
import { listCodeServerIds } from "./code-pool.service.js";
import { AppError } from "../../shared/errors.js";
import { validate } from "../../shared/validate.js";
import { actorOf } from "../../shared/audit.js";
import { listProviders,createProvider,updateProvider } from "../providers/provider.service.js";
import * as partners from "../partners/partner.service.js";
import { overview } from "./monitor.service.js";
import { setCodeServers, invalidateServerPools } from "./code-pool.service.js";
const r=Router();
r.use(authenticate,requirePartnerRole);
r.use(async(req,_res,next)=>{const p=await Partner.findByPk(req.user.partnerId);if(!p|| !["content","both"].includes(p.kind)) throw new AppError(403,"FORBIDDEN","Portal exclusivo de parceiros de conteúdo.");next();});
r.get("/overview",async(req,res)=>res.set("Cache-Control","no-store").json(await overview(req.user.partnerId)));
const srv=z.object({name:z.string().trim().min(2).max(120),baseUrl:z.string().url().max(500),priority:z.number().int().min(0).max(1000).default(0),status:z.enum(["active","disabled"]).default("active")});
// Busca e paginação no banco: milhares de códigos sem carregar tudo no navegador.
r.get("/codes",validate({query:z.object({q:z.string().trim().max(80).optional(),page:z.coerce.number().int().min(1).max(100000).default(1)})}),async(req,res)=>{
  const page=req.valid.query.page;
  const q=(req.valid.query.q||"").replace(/[\\%_]/g,"\\$&");
  const where={partnerId:req.user.partnerId,...(q?{[Op.or]:[{code:{[Op.iLike]:`%${q}%`}},{label:{[Op.iLike]:`%${q}%`}}]}:{})};
  const {rows,count}=await PartnerCode.findAndCountAll({where,attributes:["id","code","label","status","providerId"],order:[["createdAt","DESC"]],limit:25,offset:(page-1)*25});
  const pools=await listCodeServerIds(rows.map(c=>c.id));
  res.set("Cache-Control","no-store").json({rows:rows.map(c=>({...c.toJSON(),serverIds:pools.get(c.id)||(c.providerId?[c.providerId]:[])})),count,page,pageSize:25});
});
r.post("/servers",validate({body:srv}),async(req,res)=>res.status(201).json(await createProvider(req.user.partnerId,req.valid.body,actorOf(req),{max:50})));
r.patch("/servers/:id",validate({params:z.object({id:z.string().uuid()}),body:srv.partial()}),async(req,res)=>res.json(await updateProvider(req.user.partnerId,req.valid.params.id,req.valid.body,actorOf(req))));
r.post("/codes",validate({body:z.object({code:z.string().trim().min(4).max(12).optional(),label:z.string().trim().max(120).optional(),providerId:z.string().uuid()})}),async(req,res)=>res.status(201).json(await partners.createCode(req.user.partnerId,req.valid.body,actorOf(req))));
r.post("/codes/:id/revoke",validate({params:z.object({id:z.string().uuid()})}),async(req,res)=>{await partners.revokeCode(req.user.partnerId,req.valid.params.id,actorOf(req));res.status(204).end();});
r.put("/codes/:id/servers",validate({params:z.object({id:z.string().uuid()}),
  body:z.object({serverIds:z.array(z.string().uuid()).min(1).max(8)})}),
  async(req,res)=>res.json(await setCodeServers(req.user.partnerId,req.valid.params.id,req.valid.body.serverIds,actorOf(req))));
r.patch("/codes/:id",validate({params:z.object({id:z.string().uuid()}),body:z.object({providerId:z.string().uuid()})}),async(req,res)=>{const result=await partners.updateCode(req.user.partnerId,req.valid.params.id,req.valid.body,actorOf(req));invalidateServerPools(req.valid.params.id);res.json(result)});
export default r;

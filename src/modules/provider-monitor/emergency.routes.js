import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { macWriteLimiter } from '../../middleware/security.js';
import { actorOf } from '../../shared/audit.js';
import { emergencyChoices,launchEmergency,stopEmergency } from './emergency.service.js';
import { deviceDnsChoices, forceDeviceDns, endDeviceDns } from './device-dns.service.js';
const ids=z.array(z.string().uuid()).min(1).max(500);
const write=z.object({codeIds:ids,providerId:z.string().uuid().optional(),baseUrl:z.string().url().max(500).optional(),
  name:z.string().trim().min(2).max(120).optional(),minutes:z.number().int().min(1).max(360).default(30),
  notify:z.boolean().default(true),message:z.string().trim().max(300).optional(),
}).strict().refine(b=>Boolean(b.providerId)!==Boolean(b.baseUrl),{message:'Selecione uma DNS existente ou informe uma URL.'});
export function emergencyRoutes(partnerOf) {
  const r=Router({mergeParams:true});
  r.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  r.get('/device',validate({query:z.object({mac:z.string().trim().max(24)})}),async(req,res)=>res.json(
    await deviceDnsChoices(await partnerOf(req),req.valid.query.mac)));
  r.post('/device/:id',macWriteLimiter,validate({params:z.object({id:z.string().uuid()}),
    body:z.object({providerId:z.string().uuid(),minutes:z.number().int().min(1).max(360).default(30),
      notify:z.boolean().default(true),message:z.string().trim().max(300).optional()}).strict()}),
    async(req,res)=>res.status(202).json(await forceDeviceDns(await partnerOf(req),req.valid.params.id,req.valid.body,actorOf(req),req.user.id)));
  r.delete('/device/:id',macWriteLimiter,validate({params:z.object({id:z.string().uuid()})}),
    async(req,res)=>res.json(await endDeviceDns(await partnerOf(req),req.valid.params.id,actorOf(req))));
  r.get('/',async(req,res)=>res.json(await emergencyChoices(await partnerOf(req))));
  r.post('/',macWriteLimiter,validate({body:write}),async(req,res)=>res.status(202).json(
    await launchEmergency(await partnerOf(req),req.valid.body,actorOf(req),req.user.id)));
  r.delete('/',macWriteLimiter,validate({body:z.object({codeIds:ids}).strict()}),async(req,res)=>res.json(
    await stopEmergency(await partnerOf(req),req.valid.body.codeIds,actorOf(req))));
  return r;
}

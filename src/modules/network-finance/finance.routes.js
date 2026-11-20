import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { actorOf } from '../../shared/audit.js';
import { validate } from '../../shared/validate.js';
import { adminHasNetworkPermission } from '../admin-workspaces/permissions.js';
import * as svc from './finance.service.js';
import { webhookLimiter } from '../../middleware/security.js';

const id=z.object({id:z.string().uuid()});
const providerParam=z.object({provider:z.enum(['mercadopago','infinitepay'])});
const page=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25),
 adminId:z.string().uuid().optional(),partnerId:z.string().uuid().optional(),
 kind:z.enum(['renewal','upgrade']).optional(),status:z.enum(['creating','pending','paid','expired','cancelled','failed','review']).optional(),
 provider:z.enum(['mercadopago','infinitepay']).optional(),method:z.enum(['manual','automatic']).optional(),
 fromDate:z.iso.date().optional(),toDate:z.iso.date().optional(),}).strict();
const reasonBody=z.object({reason:z.string().trim().min(5).max(500)}).strict();
const configs=z.discriminatedUnion('provider',[
 z.object({provider:z.literal('mercadopago'),accessToken:z.string().trim().min(20).max(600),webhookSecret:z.string().trim().min(8).max(500)}).strict(),
 z.object({provider:z.literal('infinitepay'),handle:z.string().trim().min(2).max(40),apiKey:z.string().trim().min(14).max(250)}).strict(),
]);
const strictAdmin = (req,_res,next)=>{
 if(req.user?.role!=='admin'||req.impersonator)throw new AppError(403,'ADMIN_WORKSPACE_ONLY','Configuração reservada ao titular da rede.');
 next();
};
const scope=key=>(req,_res,next)=>{
 if(!adminHasNetworkPermission(req.user,key))throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sem permissão para finanças da rede.');
 next();
};
export const workspaceFinance=Router();
workspaceFinance.use((req,res,next)=>{res.set('Cache-Control','private,no-store');next();});
workspaceFinance.get('/gateways',strictAdmin,scope('network:gateways:read'),async(req,res)=>res.json({data:await svc.listGateways(req.networkOwnerId)}));
workspaceFinance.put('/gateways/:provider',strictAdmin,scope('network:gateways:write'),validate({params:providerParam,body:configs}),async(req,res)=>{
 if(req.valid.params.provider!==req.valid.body.provider)throw new AppError(422,'PROVIDER_MISMATCH','Provedor inválido.');
 res.json(await svc.saveGateway(req.networkOwnerId,req.valid.params.provider,req.valid.body,actorOf(req)));
});
workspaceFinance.post('/gateways/:provider/test',strictAdmin,scope('network:gateways:write'),validate({params:providerParam}),async(req,res)=>res.json(await svc.testGateway(req.networkOwnerId,req.valid.params.provider,actorOf(req))));
workspaceFinance.post('/gateways/:provider/activate',strictAdmin,scope('network:gateways:write'),validate({params:providerParam}),async(req,res)=>res.json(await svc.activateGateway(req.networkOwnerId,req.valid.params.provider,actorOf(req))));
workspaceFinance.get('/charges',scope('network:billing:read'),validate({query:page.omit({adminId:true})}),async(req,res)=>{
 const {page:current,pageSize,...filters}=req.valid.query;
 res.json(await svc.listCharges(filters,{ownerAdminId:req.networkOwnerId,limit:pageSize,offset:(current-1)*pageSize}));
});
workspaceFinance.post('/charges',strictAdmin,scope('network:billing:write'),validate({body:z.object({partnerId:z.string().uuid(),kind:z.enum(['renewal','upgrade']),planTo:z.string().min(3).max(32),method:z.enum(['automatic','manual']).default('automatic')}).strict()}),async(req,res)=>{
 const created=await svc.createCharge(req.networkOwnerId,req.valid.body,actorOf(req));res.status(201).json(created);
});
workspaceFinance.post('/charges/:id/manual',strictAdmin,scope('network:billing:write'),validate({params:id,body:z.object({reference:z.string().trim().min(5).max(160)}).strict()}),async(req,res)=>res.json(await svc.confirmManualCharge(req.networkOwnerId,req.valid.params.id,req.valid.body,actorOf(req))));
workspaceFinance.post('/charges/:id/cancel',strictAdmin,scope('network:billing:write'),validate({params:id,body:reasonBody}),async(req,res)=>res.json(await svc.cancelCharge(req.valid.params.id,req.valid.body.reason,actorOf(req),{ownerAdminId:req.networkOwnerId})));

export const superadminFinance=Router();
superadminFinance.use((req,res,next)=>{
 if(req.user?.role!=='superadmin'||req.impersonator)throw new AppError(403,'SUPERADMIN_ONLY','Consulta exclusiva do Superadmin.');
 res.set('Cache-Control','private,no-store');next();
});
superadminFinance.get('/gateways',async(_req,res)=>res.json({data:await svc.maskedAdminGatewaySummary()}));
superadminFinance.get('/charges',validate({query:page}),async(req,res)=>{
 const {page:current,pageSize,...filters}=req.valid.query;
 res.json(await svc.listCharges(filters,{superadmin:true,limit:pageSize,offset:(current-1)*pageSize}));
});
superadminFinance.get('/export.csv',validate({query:page.omit({page:true,pageSize:true})}),async(req,res)=>{
 const csv=await svc.exportChargesCsv(req.valid.query,{superadmin:true,limit:2000});
 res.type('text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="deltatv-financeiro-redes.csv"').send('\uFEFF'+csv);
});
superadminFinance.post('/charges/:id/cancel',validate({params:id,body:reasonBody}),async(req,res)=>res.json(await svc.cancelCharge(req.valid.params.id,req.valid.body.reason,actorOf(req),{superadmin:true})));

export const partnerNetworkCharges=Router();
partnerNetworkCharges.get('/',async(req,res)=>res.set('Cache-Control','private,no-store').json({data:await svc.partnerCharges(req.user.partnerId)}));

export const networkFinanceWebhooks=Router();
networkFinanceWebhooks.post('/:provider/:id',webhookLimiter,validate({params:z.object({provider:z.enum(['mercadopago','infinitepay']),id:z.string().uuid()})}),async(req,res)=>{
 res.status(200).json({ok:true,...await svc.reconcileProviderCharge(req.valid.params.id,req.valid.params.provider,req)});
});

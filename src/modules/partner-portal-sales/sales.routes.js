import {Router} from 'express';
import {z} from 'zod';
import {validate} from '../../shared/validate.js';
import {actorOf} from '../../shared/audit.js';
import {AppError} from '../../shared/errors.js';
import * as svc from './sales.service.js';

const noStore=(_req,res,next)=>{res.set('Cache-Control','no-store');next();};
const uuid=z.string().uuid();
const cents=z.number().int().min(0).max(1_000_000_000);
const qty=z.number().int().min(1).max(100_000); // Proteção por requisição, não quota comercial.
const actionId=z.object({id:uuid}).strict();
const stockOrder=z.object({sellerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty}).strict();
const assignment=z.object({sellerPartnerId:uuid,customerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),months:z.number().int().min(1).max(120),unitResaleCents:cents,monthlyFeeCents:cents.default(0),requestId:uuid}).strict();
const transfer=z.object({buyerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty,unitResaleCents:cents,requestId:uuid}).strict();
const adminOnly=(req,_res,next)=>{if(req.user?.role!=='superadmin'||req.impersonator)throw new AppError(403,'SUPERADMIN_ONLY','Somente o Superadmin administra o comércio do Painel do Parceiro.');next();};

export const adminPortalSales=Router();
adminPortalSales.use(adminOnly,noStore);
adminPortalSales.get('/',async(_req,res)=>res.json(await svc.adminOverview()));
adminPortalSales.put('/costs',validate({body:z.object({vpsMonthlyCents:cents,domainAnnualCents:cents,otherMonthlyCents:cents,proxyCostPerGbCents:cents,forecastProxyGbPerPartner:z.number().int().min(0).max(1000000),targetMarginBp:z.number().int().min(0).max(8000),taxBp:z.number().int().min(0).max(2500),reserveBp:z.number().int().min(0).max(6000)}).strict().refine(x=>x.targetMarginBp+x.taxBp<9000)}),async(req,res)=>res.json(await svc.updateCosts(req.valid.body,actorOf(req))));
adminPortalSales.get('/candidates',validate({query:z.object({q:z.string().trim().max(80).default('')})}),async(req,res)=>res.json(await svc.adminCandidates(req.valid.query.q)));
adminPortalSales.post('/sellers',validate({body:z.object({partnerId:uuid,parentPartnerId:uuid.nullable().optional()}).strict()}),async(req,res)=>res.status(201).json(await svc.registerSeller(req.valid.body,actorOf(req))));
adminPortalSales.patch('/sellers/:id',validate({params:actionId,body:z.object({active:z.boolean().optional(),canSell:z.boolean().optional()}).strict().refine(x=>Object.keys(x).length>0)}),async(req,res)=>res.json(await svc.setSellerState(req.valid.params.id,req.valid.body,actorOf(req))));
adminPortalSales.put('/plans',validate({body:z.object({code:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),name:z.string().trim().min(2).max(120),wholesaleCents:cents.min(1),minResaleCents:cents.min(1),active:z.boolean().default(true)}).strict()}),async(req,res)=>res.json(await svc.savePlan(req.valid.body,actorOf(req))));
adminPortalSales.post('/orders',validate({body:stockOrder}),async(req,res)=>res.status(201).json(await svc.createStockOrder(req.valid.body,actorOf(req))));
adminPortalSales.post('/orders/:id/settle',validate({params:actionId,body:z.object({settlementRef:z.string().trim().min(6).max(120),method:z.enum(['pix_manual_confirmed','bank_manual_confirmed','cash_manual_confirmed'])}).strict()}),async(req,res)=>res.json(await svc.settleStockOrder(req.valid.params.id,req.valid.body,actorOf(req))));
adminPortalSales.post('/exceptions',validate({body:z.object({sellerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty,reason:z.string().trim().min(10).max(500)}).strict()}),async(req,res)=>res.status(201).json(await svc.grantException(req.valid.body,actorOf(req))));
adminPortalSales.post('/contracts',validate({body:assignment}),async(req,res)=>res.status(201).json(await svc.assignAccess(req.valid.body,actorOf(req),{admin:true})));

export const partnerPortalSales=Router();
partnerPortalSales.use(noStore);
partnerPortalSales.get('/',async(req,res)=>res.json(await svc.sellerOverview(req.user.partnerId)));
partnerPortalSales.post('/transfers',validate({body:transfer}),async(req,res)=>res.status(201).json(await svc.transfer({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));
partnerPortalSales.post('/renewals',validate({body:assignment.omit({sellerPartnerId:true})}),async(req,res)=>res.status(201).json(await svc.assignAccess({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));

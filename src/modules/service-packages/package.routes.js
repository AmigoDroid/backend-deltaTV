import {Router} from 'express';
import {z} from 'zod';
import {validate} from '../../shared/validate.js';
import {actorOf} from '../../shared/audit.js';
import {AppError} from '../../shared/errors.js';
import {listServicePackages,createServicePackage,saveServicePackage,toggleServicePackage,duplicateServicePackage,assignServicePackage,getPartnerAssignedPackage} from './package.service.js';

const router=Router();
router.use((req,res,next)=>{
 if(req.user?.role!=='superadmin'||req.impersonator)
  throw new AppError(403,'DELTATV_ONLY','Esta configuração pertence à DeltaTV.');
 res.set('Cache-Control','no-store');next();
});
const code=z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);
const id=z.string().uuid();
const money=z.number().int().min(0).max(1_000_000_000);
const schema=z.object({code,name:z.string().trim().min(2).max(120),wholesaleCents:money,minResaleCents:money,
 audience:z.enum(['content','reseller','both']).optional(),validityDays:z.number().int().min(1).max(3660).optional(),
 monthlyPriceCents:money.max(100000000).nullable().optional(), hiddenFromNetwork:z.boolean().optional(),
 canResellPanel:z.boolean().optional(),canCreateSubmasters:z.boolean().optional(),canViewFinance:z.boolean().optional(),canManageGateways:z.boolean().optional(),
 active:z.boolean().default(true),maxDns:z.number().int().min(1).max(2_000_000).nullable(),
 activationLimit:z.number().int().min(0).max(2_000_000_000).nullable(),maxApps:z.number().int().min(0).max(50).optional(),
 autoFailover:z.boolean(),autoPriority:z.boolean(),emailAlerts:z.boolean(),detailedHistory:z.boolean()}).strict();
router.get('/',async(_req,res)=>res.json({items:await listServicePackages()}));
router.post('/',validate({body:schema}),async(req,res)=>res.status(201).json(await createServicePackage(req.valid.body,actorOf(req))));
router.put('/:code',validate({params:z.object({code}),body:schema}),async(req,res)=>{
 if(req.valid.params.code!==req.valid.body.code)throw new AppError(422,'PACKAGE_CODE_IMMUTABLE','Não altere o código do pacote. Duplique-o para criar outro.');
 res.json(await saveServicePackage(req.valid.body,actorOf(req)));
});
router.patch('/:code/state',validate({params:z.object({code}),body:z.object({active:z.boolean()}).strict()}),
 async(req,res)=>res.json(await toggleServicePackage(req.valid.params.code,req.valid.body.active,actorOf(req))));
router.post('/:code/duplicate',validate({params:z.object({code}),body:z.object({newCode:code,newName:z.string().trim().min(2).max(120)}).strict()}),
 async(req,res)=>res.status(201).json(await duplicateServicePackage(req.valid.params.code,req.valid.body,actorOf(req))));
router.get('/partners/:partnerId',validate({params:z.object({partnerId:id})}),async(req,res)=>
 res.json(await getPartnerAssignedPackage(req.valid.params.partnerId)));
router.put('/partners/:partnerId',validate({params:z.object({partnerId:id}),body:z.object({code}).strict()}),
 async(req,res)=>res.json(await assignServicePackage(req.valid.params.partnerId,req.valid.body.code,actorOf(req))));
export default router;

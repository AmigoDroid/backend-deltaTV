import {Router} from 'express';
import {z} from 'zod';
import {validate} from '../../shared/validate.js';
import {actorOf} from '../../shared/audit.js';
import {AppError} from '../../shared/errors.js';
import {getGlobalConfig,updateGlobalSection} from './config.service.js';
import {PORTAL_PAYMENT_GATEWAYS} from '../partner-portal-sales/checkout.rules.js';
const router=Router();
router.use((req,res,next)=>{if(req.user?.role!=='superadmin'||req.impersonator)
 throw new AppError(403,'DELTATV_ONLY','Somente a DeltaTV administra configurações globais.');
 res.set('Cache-Control','no-store');next();});
const price=z.number().int().min(0).max(1_000_000_000);
const mode=z.enum(['proxy','redirect']);
const schemas={
 trial:z.object({enabled:z.boolean(),days:z.number().int().min(1).max(365)}).strict(),
 web:z.object({autoHttps:z.boolean(),deliveryModes:z.object({api:mode,live:mode,movie:mode,series:mode}).strict()}).strict(),
 payments:z.object({defaultGateway:z.enum(PORTAL_PAYMENT_GATEWAYS)}).strict(),
 costs:z.object({vpsMonthlyCents:price,domainAnnualCents:price,otherMonthlyCents:price,
  proxyCostPerGbCents:price,forecastProxyGbPerPartner:z.number().int().min(0).max(1_000_000),
  targetMarginBp:z.number().int().min(0).max(8000),taxBp:z.number().int().min(0).max(2500),
  reserveBp:z.number().int().min(0).max(6000)}).strict().refine(x=>x.targetMarginBp+x.taxBp<9000)
};
router.get('/',async(_req,res)=>res.json(await getGlobalConfig()));
for(const [section,schema] of Object.entries(schemas))router.put(`/${section}`,validate({body:schema}),
 async(req,res)=>res.json(await updateGlobalSection(section,req.valid.body,actorOf(req))));
export default router;

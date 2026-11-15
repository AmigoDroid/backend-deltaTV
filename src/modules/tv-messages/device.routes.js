import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { heartbeatLimiter } from '../../middleware/security.js';
import { requireTelemetry } from '../connection-audit/routes.js';
import { pendingForDevice, markRead } from './message.service.js';

const router = Router();
router.use(heartbeatLimiter, requireTelemetry);
router.get('/',async(req,res)=>res.set('Cache-Control','no-store').json(
  await pendingForDevice(req.device.activation.id)));
router.post('/:id/read',validate({ params:z.object({id:z.string().uuid()}).strict() }),
  async(req,res)=>res.set('Cache-Control','no-store').json(await markRead({
    activationId:req.device.activation.id,deliveryId:req.valid.params.id,
  })));
export default router;

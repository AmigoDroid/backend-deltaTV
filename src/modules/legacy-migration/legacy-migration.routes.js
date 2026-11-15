import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authenticate.js';
import { AppError } from '../../shared/errors.js';
import { validate } from '../../shared/validate.js';
import { actorOf } from '../../shared/audit.js';
import { clientWriteLimiter } from '../../middleware/security.js';
import * as migration from './legacy-migration.service.js';

const router = Router();
// O inventário cruza vínculos de clientes e licenças. Nesta etapa, disponível somente ao Superadmin.
router.use((req, _res, next) => req.user?.role === 'superadmin' ? next() : next(new AppError(403,'FORBIDDEN','Somente o Superadmin pode migrar registros legados.')));
const uuid = z.string().uuid();
router.get('/preview', requirePermission('devices:read'), validate({ query: z.object({
  partnerId: uuid, page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
}) }), async(req,res) => res.set('Cache-Control','no-store').json(await migration.previewLegacy(req.valid.query.partnerId, req.valid.query)));
router.post('/import-customer', requirePermission('clients:write'), clientWriteLimiter,
  validate({ body: z.object({ partnerId:uuid, legacyClientId:uuid }).strict() }),
  async(req,res) => res.json(await migration.importLegacyCustomer({ ...req.valid.body, actor: actorOf(req) })));
router.post('/link-activation', requirePermission('devices:write'), clientWriteLimiter,
  validate({ body: z.object({ partnerId:uuid, legacyClientId:uuid, activationId:uuid, subscriptionId:uuid,
    acknowledgeNoLicenseChange: z.literal(true), acknowledgeSharedMac: z.boolean().default(false),
  }).strict() }),
  async(req,res) => res.json(await migration.linkLegacyActivation({ ...req.valid.body, actor: actorOf(req) })));
export default router;

import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { publicAppReadLimiter, publicAppLinkIpLimiter, publicAppLinkMacLimiter } from '../../middleware/security.js';
import { linkFromPublicQr, publicAppMetadata } from './client-app-public.service.js';

const router = Router();
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/);
const params = z.object({ identifier }).strict();
const mac = z.string().regex(/^[0-9A-F]{12}$/);
const token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);

router.get('/:identifier', publicAppReadLimiter,
  validate({ params, query: z.object({}).strict() }),
  async (req, res) => res.json(await publicAppMetadata(req.valid.params.identifier)));
router.post('/:identifier/verify', publicAppReadLimiter,
  validate({ params, body: z.object({ mac: z.string().min(1).max(20), token: z.string().min(1).max(100) }).strict() }),
  async (req, res) => res.json(await publicAppMetadata(req.valid.params.identifier, req.valid.body)));
router.post('/:identifier/link', publicAppLinkIpLimiter, publicAppLinkMacLimiter,
  validate({ params, body: z.object({ mac, token, username: z.string().min(1).max(128),
    password: z.string().min(1).max(128) }).strict() }),
  async (req, res) => res.json(await linkFromPublicQr(req.valid.params.identifier, req.valid.body,
    { ip: req.ip, userAgent: req.get('user-agent') })));
export default router;

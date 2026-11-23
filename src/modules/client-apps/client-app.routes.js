import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { actorOf } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import { requirePermission } from '../../middleware/authenticate.js';
import { macWriteLimiter } from '../../middleware/security.js';
import { pageQuery } from '../../shared/pagination.js';
import { listPartnerUnlinkedDevices, countPartnerUnlinkedDevices, linkPartnerUnlinkedDevice } from '../devices/unlinked.service.js';
import { createPlatformApp, listPlatformApps, editPlatformApp, issueClaimCode, claimPlatformApp, assignPlatformApp,
  unassignPlatformApp, listPartnerApps, updatePartnerApp } from './client-app.service.js';

const id = z.object({ id: z.string().uuid() });
const appIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const theme = z.object({ background: color, panel: color, primary: color, text: color, muted: color }).strict();
const branding = { logoUrl: z.string().url().startsWith('https://').max(1000).nullable().optional(), theme: theme.nullable().optional() };

export const adminClientAppsRouter = Router();
adminClientAppsRouter.use(requirePermission('override'));
adminClientAppsRouter.get('/', async (_req, res) => res.set('Cache-Control', 'no-store').json({ data: await listPlatformApps() }));
adminClientAppsRouter.post('/', validate({ body: z.object({ identifier: appIdentifier, name: z.string().trim().min(2).max(120), status: z.enum(['active', 'suspended']).default('active'), ...branding }).strict() }),
  async (req, res) => res.status(201).json(await createPlatformApp(req.valid.body, actorOf(req))));
adminClientAppsRouter.patch('/:id', validate({ params: id, body: z.object({ name: z.string().trim().min(2).max(120).optional(), status: z.enum(['active', 'suspended']).optional(), ...branding }).strict() }),
  async (req, res) => res.json(await editPlatformApp(req.valid.params.id, req.valid.body, actorOf(req))));
adminClientAppsRouter.post('/:id/claim-code', validate({ params: id, body: z.object({ expiresMinutes: z.number().int().min(5).max(10080).default(1440) }).strict() }),
  async (req, res) => res.json(await issueClaimCode(req.valid.params.id, req.valid.body.expiresMinutes, actorOf(req))));
adminClientAppsRouter.post('/:id/assign', validate({ params: id, body: z.object({ partnerId: z.string().uuid(), partnerCodeId: z.string().uuid() }).strict() }),
  async (req, res) => res.status(201).json(await assignPlatformApp(req.valid.params.id, req.valid.body, actorOf(req))));
adminClientAppsRouter.delete('/:id/assign', validate({ params: id }), async (req, res) => res.json(await unassignPlatformApp(req.valid.params.id, actorOf(req))));

export const partnerClientAppsRouter = Router();
partnerClientAppsRouter.get('/', async (req, res) => res.set('Cache-Control', 'no-store').json(await listPartnerApps(req.user.partnerId)));
partnerClientAppsRouter.post('/claim', macWriteLimiter, validate({ body: z.object({ identifier: appIdentifier, claimCode: z.string().min(10).max(150), partnerCodeId: z.string().uuid() }).strict() }),
  async (req, res) => res.status(201).json(await claimPlatformApp(req.valid.body, req.user.partnerId, actorOf(req))));
partnerClientAppsRouter.patch('/:id', validate({ params: id, body: z.object({ partnerCodeId: z.string().uuid().optional(), status: z.enum(['active', 'paused']).optional() }).strict() }),
  async (req, res) => res.json(await updatePartnerApp(req.valid.params.id, req.user.partnerId, req.valid.body, actorOf(req))));

export const partnerAppUnlinkedRouter = Router();
partnerAppUnlinkedRouter.get('/', validate({ query: z.object({ ...pageQuery, q: z.string().max(40).optional() }) }),
  async (req, res) => res.set('Cache-Control', 'no-store').json(await listPartnerUnlinkedDevices(req.user.partnerId, req.valid.query)));
partnerAppUnlinkedRouter.get('/count', async (req, res) => res.set('Cache-Control', 'no-store').json(await countPartnerUnlinkedDevices(req.user.partnerId)));
partnerAppUnlinkedRouter.post('/:id/link', macWriteLimiter,
  validate({ params: id, body: z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(128) }).strict() }),
  async (req, res) => res.json(await linkPartnerUnlinkedDevice(req.valid.params.id, req.valid.body, req.user.partnerId, actorOf(req))));

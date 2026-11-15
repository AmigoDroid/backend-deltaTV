import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { macWriteLimiter } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { validate } from '../../shared/validate.js';
import { actorOf, audit } from '../../shared/audit.js';
import { messageScope } from './message.policy.js';
import { listRecipients, listCampaigns, previewMessage, sendMessage, cancelMessage } from './message.service.js';

const router = Router();
router.use(authenticate);
router.use((req, _res, next) => {
  const scope = messageScope(req.user);
  if (!scope) throw new AppError(403,'FORBIDDEN','Você não pode gerenciar mensagens de TVs.');
  req.tvMessagesScope = scope;
  next();
});
const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict();
const selection = z.object({
  audience: z.enum(['all','selected']),
  deviceIds: z.array(z.string().uuid()).max(500).default([]),
}).strict().refine(v => v.audience !== 'selected' || v.deviceIds.length > 0,
  { message:'Selecione pelo menos uma TV.', path:['deviceIds'] });
const sendBody = z.object({
  audience: z.enum(['all','selected']), deviceIds: z.array(z.string().uuid()).max(500).default([]),
  title: z.string().trim().min(3).max(100),
  message: z.string().trim().min(3).max(1200),
  expiresInDays: z.number().int().min(1).max(30),
  requestId: z.string().uuid(),
}).strict().refine(v => v.audience !== 'selected' || v.deviceIds.length > 0,
  { message:'Selecione pelo menos uma TV.', path:['deviceIds'] });
const id = z.object({ id: z.string().uuid() }).strict();
router.get('/recipients', validate({ query: pagination.extend({ q: z.string().trim().max(80).default('') }) }),
  async (req,res) => res.set('Cache-Control','no-store').json(await listRecipients({
    ...req.tvMessagesScope, ...req.valid.query,
  })));
router.get('/', validate({ query: pagination }),
  async (req,res) => res.set('Cache-Control','no-store').json(await listCampaigns({
    userId:req.user.id, page:req.valid.query.page,
  })));
router.post('/preview', macWriteLimiter, validate({ body: selection }),
  async (req,res) => res.set('Cache-Control','no-store').json(await previewMessage({
    ...req.tvMessagesScope,...req.valid.body,
  })));
router.post('/', macWriteLimiter, validate({ body: sendBody }), async (req,res) => {
  const result = await sendMessage({ userId:req.user.id,...req.tvMessagesScope,...req.valid.body });
  if (!result.repeated) await audit({ actor:actorOf(req), action:'tv_message.send',
    entityType:'tv_message_campaign',entityId:result.campaignId, metadata:{ total:result.total,
      audience:req.valid.body.audience,expiresInDays:req.valid.body.expiresInDays } });
  res.status(result.repeated ? 200 : 201).set('Cache-Control','no-store').json(result);
});
router.post('/:id/cancel', macWriteLimiter, validate({ params:id }), async(req,res) => {
  const result = await cancelMessage({ userId:req.user.id,id:req.valid.params.id });
  await audit({actor:actorOf(req),action:'tv_message.cancel',entityType:'tv_message_campaign',entityId:req.valid.params.id});
  res.set('Cache-Control','no-store').json(result);
});
export default router;

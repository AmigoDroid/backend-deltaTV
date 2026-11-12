/** Proxy TMDB restrito, com chave somente no backend e consultas autenticadas. */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { AppError } from '../../shared/errors.js';
import { requireDevice } from '../access/access.middleware.js';

export const tmdbProxy = Router();
const query = validate({ query: z.object({
  path: z.string().trim().regex(/^(configuration|search\/(movie|tv)|(movie|tv)\/[1-9]\d{0,12})$/),
  query: z.string().max(500).optional(),
}).strict() });
const cache = new Map();
const budget = new Map();
const CAP = 120;
const MAX_UPSTREAM_CONCURRENT = 10;
let upstreamActive = 0;
let lastTrim = 0;

tmdbProxy.get('/', requireDevice('device'), query, async (req, res) => {
  const token = process.env.TMDB_READ_TOKEN || '';
  if (!token) throw new AppError(503, 'TMDB_NOT_CONFIGURED', 'Metadados TMDB indisponíveis.');
  const params = new URLSearchParams(String(req.valid.query.query || '').replace(/^&/, ''));
  const destination = new URL(`https://api.themoviedb.org/3/${req.valid.query.path}`);
  for (const [key, value] of params) {
    if (!['language', 'query', 'include_adult', 'page'].includes(key) || value.length > 160) throw new AppError(422,'INVALID_TMDB_QUERY','Consulta TMDB inválida.');
    destination.searchParams.set(key, value);
  }
  const key = destination.pathname + destination.search;
  const now = Date.now();
  if (cache.has(key) && cache.get(key).expires > now) {
    return res.set('Cache-Control','private, max-age=300').json(cache.get(key).body);
  }
  const id = String(req.device.activation.id);
  const allowed = budget.get(id) || { until: now + 60000, used: 0 };
  if (allowed.until <= now) { allowed.until = now + 60000; allowed.used = 0; }
  if (++allowed.used > 15) throw new AppError(429, 'TMDB_LIMIT', 'Muitas consultas TMDB.');
  budget.set(id, allowed);
  if (now - lastTrim > 60000) {
    lastTrim = now;
    for (const [k, v] of budget) if (v.until < now) budget.delete(k);
    for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
  }
  if (upstreamActive >= MAX_UPSTREAM_CONCURRENT) throw new AppError(429, 'TMDB_BUSY', 'Serviço de metadados ocupado.');
  upstreamActive++;
  try {
    const reply = await fetch(destination, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(7000),
    });
    if (!reply.ok) return res.status(reply.status).set('Cache-Control','no-store').json({ status: reply.status, message: 'TMDB indisponível' });
    const contentLength = Number(reply.headers.get('content-length') || 0);
    if (contentLength > 150_000) throw new Error('Oversized TMDB response');
    const raw = await reply.text();
    if (raw.length > 150_000) throw new Error('Oversized TMDB response');
    const body = JSON.parse(raw);
    if (cache.size >= CAP && !cache.has(key)) cache.delete(cache.keys().next().value);
    cache.set(key, { body, expires: now + 3600000 });
    return res.set('Cache-Control','private, max-age=300').json(body);
  } catch {
    throw new AppError(502, 'TMDB_UNAVAILABLE', 'Não foi possível consultar o TMDB.');
  } finally { upstreamActive--; }
});

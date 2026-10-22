import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { notFound } from "../../shared/errors.js";
import { requireDevice } from "../access/access.middleware.js";
import { PERSONAL, getAllowedSource, hasPersonalPlaylist } from "../sources/sources.service.js";
import { repo, ensureCatalog } from "./catalog.runtime.js";
import * as Q from "./query.service.js";
import * as X from "../xtream/xtream.catalog.js";
import { xtreamAccountOf } from "../xtream/xtream.client.js";

/**
 * Catálogo paginado para os clientes — /api/v1/client/catalog/*  (a rota antiga GET /client/catalog continua existindo).
 *
 * Autorização: sessão do dispositivo (requireDevice) + a lista precisa ser uma das AUTORIZADAS para esta ativação
 * (a própria lista ou uma fonte permitida). O escopo nunca vem do cliente: ele só escolhe QUAL das suas listas.
 * Nenhuma resposta contém a URL de origem; a reprodução usa srcVideo (gateway) + play token.
 *
 *   GET /groups?sourceId&kind=live|movie|series        pastas (nome original do M3U) + contagem
 *   GET /items?sourceId&kind&groupId[&q&cursor&pageSize]   canais/filmes de UMA pasta
 *   GET /series?sourceId[&groupId&q&cursor&pageSize]       séries
 *   GET /series/:seriesId/seasons?sourceId                 temporadas
 *   GET /series/:seriesId/episodes?sourceId[&season&cursor&pageSize]
 *   GET /items/:id?sourceId                                detalhes de um item
 *   GET /status?sourceId                                   preparando | pronto | falhou
 */
const router = Router();
router.use(requireDevice());

const sourceId = z.union([z.string().uuid(), z.literal(PERSONAL)]);
const paging = { cursor: z.string().max(400).optional(), pageSize: z.coerce.number().int().min(1).max(Q.PAGE.max).optional() };
const kind = z.enum(["live", "movie", "series"]);
const itemId = z.string().refine((v) => Q.isUuid(v) || X.isXtreamId(v), "id inválido");
const seriesIdSchema = z.string().refine((v) => /^s_[0-9a-f]{24}$/.test(v) || X.isXtreamSeriesId(v), "seriesId inválido");

// Mesma consulta nos dois modos: Xtream (sob demanda) ou catálogo persistente (PostgreSQL).
const run = (ctx, name, args) =>
  ctx.xtream ? X[name]({ ...args, account: ctx.xtream }) : Q[name]({ repo, scope: ctx.scope, ...args });

async function ctxOf(req) {
  const { activation } = req.device;
  const id = req.valid.query.sourceId;
  if (id === PERSONAL) {
    if (!hasPersonalPlaylist(activation)) throw notFound("Lista");
    // Painel Xtream: catálogo sob demanda pela API (nada é importado para o banco). Outras listas: catálogo persistente.
    return { sourceId: id, scope: { type: "activation", id: activation.id }, activation, xtream: await xtreamAccountOf(activation) };
  }
  const source = await getAllowedSource(activation, id); // 404 se não for uma fonte autorizada para esta ativação
  return { sourceId: id, scope: { type: "source", id: source.id }, source };
}

// Nenhuma rota espera o download: sem catálogo publicado, dispara a importação em segundo plano e responde 503 + Retry-After.
const handler = (fn) => async (req, res) => {
  const ctx = await ctxOf(req);
  try {
    res.set("Cache-Control", "no-store");
    res.json(await fn(ctx, req));
  } catch (e) {
    if (e?.code === "CATALOG_PREPARING") {
      await ensureCatalog(ctx);
      res.set("Retry-After", "5");
    }
    throw e;
  }
};

// Caminho do gateway: o cliente acrescenta ?t=<playToken> (POST /client/play-token). A origem nunca é exposta.
const withPlay = (ctx) => (it) => ({ ...it, srcVideo: `/api/v1/play/${ctx.sourceId}/${it.id}${it.ext}` });

router.get("/groups", validate({ query: z.object({ sourceId, kind }) }), handler(async (ctx, req) => {
  const out = await run(ctx, "listGroups", { kind: req.valid.query.kind });
  if (!ctx.xtream) ensureCatalog(ctx).catch(() => {}); // renovação em segundo plano quando a versão está velha
  return out;
}));

router.get("/items", validate({ query: z.object({ sourceId, kind: z.enum(["live", "movie"]), groupId: z.string().max(40).optional(), q: z.string().trim().min(2).max(100).optional(), ...paging }) }),
  handler(async (ctx, req) => {
    const { sourceId: _s, ...args } = req.valid.query;
    const r = await run(ctx, "listItems", args);
    return { ...r, items: r.items.map(withPlay(ctx)) };
  }));

router.get("/series", validate({ query: z.object({ sourceId, groupId: z.string().max(40).optional(), q: z.string().trim().min(2).max(100).optional(), ...paging }) }),
  handler((ctx, req) => { const { sourceId: _s, ...args } = req.valid.query; return run(ctx, "listSeries", args); }));

const seriesParam = z.object({ seriesId: seriesIdSchema });
router.get("/series/:seriesId/seasons", validate({ params: seriesParam, query: z.object({ sourceId }) }),
  handler((ctx, req) => run(ctx, "listSeasons", { seriesId: req.valid.params.seriesId })));

router.get("/series/:seriesId/episodes", validate({ params: seriesParam, query: z.object({ sourceId, season: z.coerce.number().int().min(0).max(1000).optional(), ...paging }) }),
  handler(async (ctx, req) => {
    const { sourceId: _s, ...q } = req.valid.query;
    const r = await run(ctx, "listEpisodes", { seriesId: req.valid.params.seriesId, ...q });
    return { ...r, episodes: r.episodes.map(withPlay(ctx)) };
  }));

router.get("/items/:id", validate({ params: z.object({ id: itemId }), query: z.object({ sourceId }) }),
  handler(async (ctx, req) => {
    const r = await run(ctx, "getItem", { id: req.valid.params.id });
    return { ...r, item: withPlay(ctx)(r.item) };
  }));

router.get("/status", validate({ query: z.object({ sourceId }) }), async (req, res) => {
  const ctx = await ctxOf(req);
  if (ctx.xtream) {
    return res.set("Cache-Control", "no-store").json({ state: "ready", catalogVersion: "xtream", itemCount: 0, publishedAt: null });
  }
  const state = await ensureCatalog(ctx);
  const active = await repo.activeImport(ctx.scope);
  res.set("Cache-Control", "no-store").json({
    state: active ? "ready" : state === "failed" ? "failed" : "preparing",
    catalogVersion: active?.id ?? null, itemCount: active?.itemCount ?? 0, publishedAt: active?.publishedAt ?? null,
  });
});

export default router;

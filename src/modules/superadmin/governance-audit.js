import { AsyncLocalStorage } from "node:async_hooks";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/models/index.js";
import { audit, actorOf } from "../../shared/audit.js";
const context = new AsyncLocalStorage(),
  stamped = new WeakMap(),
  baseQuery = sequelize.query.bind(sequelize);
const mutates = (text) =>
  /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text) ||
  (/^\s*WITH\b/i.test(text) &&
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(text));
/** Scope attribution to the same PostgreSQL transaction; pooled connections cannot retain another actor. */
sequelize.query = async function (statement, options = {}) {
  const state = context.getStore(),
    text = typeof statement === "string" ? statement : statement?.query || "";
  if (
    !state?.active ||
    !mutates(text) ||
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?audit_logs"?\b/i.test(text)
  )
    return baseQuery(statement, options);
  const actor = actorOf(state.req),
    marker = state.req.id,
    owned = !options.transaction;
  const transaction = options.transaction || (await sequelize.transaction());
  try {
    if (stamped.get(transaction) !== marker) {
      await baseQuery("SELECT set_config('deltatv.audit_actor',$actor,true)", {
        transaction,
        bind: {
          actor: JSON.stringify({
            id: actor.id,
            name: actor.name,
            ip: actor.ip,
            requestId: marker,
            impersonatedUserId: actor.impersonatedUserId,
          }),
        },
        type: QueryTypes.SELECT,
      });
      stamped.set(transaction, marker);
    }
    const result = await baseQuery(statement, { ...options, transaction });
    if (owned) await transaction.commit();
    return result;
  } catch (error) {
    if (owned && !transaction.finished) await transaction.rollback();
    throw error;
  }
};
/** Intent is durable before dispatch; completion is durable before sending the response. */
export async function governanceAudit(req, res, next) {
  if (
    req._governanceAudited ||
    !(req.user?.role === "superadmin" || req.impersonator)
  )
    return next();
  req._governanceAudited = true;
  const entityType = "http_request",
    entityId = req.id,
    route = req.originalUrl.split("?")[0].slice(0, 200);
  await audit({
    actor: actorOf(req),
    action: "request.begin",
    entityType,
    entityId,
    metadata: {
      method: req.method,
      route,
      inputFields: Object.keys(req.body || {}),
      reason: req.body?.reason,
    },
  });
  const state = { req, active: true },
    json = res.json.bind(res),
    end = res.end.bind(res);
  let finished = false;
  const record = async (body) => {
    if (finished) return;
    finished = true;
    await audit({
      actor: actorOf(req),
      action: "request.complete",
      entityType,
      entityId,
      result: res.statusCode >= 400 ? "failure" : "success",
      metadata: {
        method: req.method,
        route,
        status: res.statusCode,
        resultId: body?.id || body?.license?.id || null,
        records: body?.meta?.total ?? body?.data?.length ?? null,
      },
    });
    state.active = false;
  };
  res.on("close", () => {
    state.active = false;
  });
  res.json = (body) => {
    if (finished) return json(body);
    record(body)
      .then(() => json(body))
      .catch((error) => {
        state.active = false;
        next(error);
      });
    return res;
  };
  res.end = (...args) => {
    if (finished) return end(...args);
    record()
      .then(() => end(...args))
      .catch((error) => {
        state.active = false;
        next(error);
      });
    return res;
  };
  context.run(state, next);
}

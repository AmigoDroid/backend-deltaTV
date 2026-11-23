export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = "Recurso") =>
  new AppError(404, "NOT_FOUND", `${what} não encontrado.`);

// Erros de validação são públicos: nunca expor mensagens técnicas nem os dados informados.
const validationLabels = {
  claimCode: "Código de vinculação",
  identifier: "Identificador do aplicativo",
  partnerCodeId: "Código da parceria",
  partnerId: "Parceiro",
  username: "Usuário",
  password: "Senha",
  email: "E-mail",
  name: "Nome",
};

function validationIssueMessage(issue) {
  const key = String(issue.path?.at(-1) ?? "");
  const label = validationLabels[key] || (key ? "Campo informado" : "Dados enviados");
  const min = Number.isFinite(issue.minimum) ? issue.minimum : null;
  const max = Number.isFinite(issue.maximum) ? issue.maximum : null;
  let reason = "Informe um valor válido.";
  if (issue.code === "invalid_type" && issue.input === undefined) reason = "Este campo é obrigatório.";
  else if (issue.code === "too_small" && min !== null) {
    reason = issue.origin === "string" ? `Informe pelo menos ${min} caracteres.` : `O valor mínimo permitido é ${min}.`;
  } else if (issue.code === "too_big" && max !== null) {
    reason = issue.origin === "string" ? `Informe no máximo ${max} caracteres.` : `O valor máximo permitido é ${max}.`;
  } else if (issue.code === "invalid_format") {
    reason = issue.format === "uuid" ? "Selecione um identificador válido." : "O formato informado é inválido.";
  } else if (issue.code === "unrecognized_keys") reason = "Existem campos não permitidos.";
  return `${label}: ${reason}`;
}

// Resposta padronizada: { code, message, details?, requestId }
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Erro interno. Tente novamente em instantes.";
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err?.name === "ZodError") {
    status = 400;
    code = "VALIDATION_ERROR";
    const first = err.issues[0];
    message = first ? validationIssueMessage(first) : "Dados inválidos.";
    details = err.issues.map((i) => ({
      path: i.path.join("."),
      message: validationIssueMessage(i),
    }));
  } else if (err?.name === "SequelizeUniqueConstraintError") {
    status = 409;
    code = "CONFLICT";
    message = "Já existe um registro com estes dados.";
  } else if (err?.name === "SequelizeForeignKeyConstraintError") {
    status = 409;
    code = "RELATED_RECORDS";
    message = "Operação não permitida: existem registros relacionados.";
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Corpo da requisição inválido.";
  } else if (err?.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Corpo da requisição muito grande.";
  }

  if (code === "VALIDATION_ERROR" && details) {
    // Só caminhos e mensagens do zod (nunca valores): mostra no terminal qual campo faltou/está inválido.
    console.warn(
      `[${req.id}] VALIDATION_ERROR ${req.method} ${req.originalUrl.split("?")[0]} -> ${details.map((d) => `${d.path || "(corpo)"}: ${d.message}`).join("; ")}`,
    );
  }
  if (status >= 500) {
    // Only PostgreSQL diagnostic identifiers: never log SQL or parameter values
    // (which can contain end-user credentials).
    const pg = err?.parent ?? err?.original;
    const pgCode = typeof pg?.code === "string" ? pg.code : null;
    const pgTable = typeof pg?.table === "string" ? pg.table : null;
    const pgColumn = typeof pg?.column === "string" ? pg.column : null;
    // Metadados não sensíveis para encontrar SQL inválido (42601) sem registrar
    // a instrução completa, parâmetros, tokens, credenciais ou URLs de origem.
    const pgPosition = typeof pg?.position === "string" && /^\d{1,8}$/.test(pg.position) ? pg.position : null;
    const route = typeof req.route?.path === "string" ? req.route.path : "(rota não identificada)";
    const statement = typeof err?.sql === "string" ? err.sql : "";
    const sqlKind = /^(SELECT|INSERT|UPDATE|DELETE|WITH|ALTER|CREATE|DROP)\b/i.exec(statement.trim())?.[1]?.toUpperCase() ?? null;
    const pgInfo = [pgCode && `pgCode=${pgCode}`, pgTable && `table=${pgTable}`, pgColumn && `column=${pgColumn}`,
      pgPosition && `position=${pgPosition}`, sqlKind && `sqlType=${sqlKind}`]
      .filter(Boolean).join(" ");
    console.error(`[${req.id}] ${req.method} ${route} ${err?.name ?? "Error"} (${err?.code ?? "no-code"})${pgInfo ? ` ${pgInfo}` : ""}`);
  }
  if (res.headersSent) return res.destroy();
  return res.status(status).json({
    code,
    message,
    ...(details ? { details } : {}),
    requestId: req.id,
  });
}

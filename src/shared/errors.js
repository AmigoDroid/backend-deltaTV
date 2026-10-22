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
    // Inclui o campo para o erro ser acionável (ex.: "registrationToken: Required"). Só nomes de campo, nunca valores.
    message = first
      ? first.path.length
        ? `${first.path.join(".")}: ${first.message}`
        : first.message
      : "Dados inválidos.";
    details = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
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
  if (status >= 500)
    console.error(
      `[${req.id}] ${err?.name ?? "Error"} (${err?.code ?? "no-code"})`,
    );
  if (res.headersSent) return res.destroy();
  return res.status(status).json({
    code,
    message,
    ...(details ? { details } : {}),
    requestId: req.id,
  });
}

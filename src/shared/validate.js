import { z } from "zod";

// Mensagens de validação no mesmo idioma dos painéis.
z.config(z.locales.pt());

// Valida body/query/params com zod; resultado em req.valid (req.query é somente leitura no Express 5).
export const validate = (schemas) => (req, _res, next) => {
  req.valid = {};
  for (const part of ["params", "query", "body"]) {
    if (schemas[part]) req.valid[part] = schemas[part].parse(req[part] ?? {});
  }
  next();
};

// Zod 4 aplica defaults dentro de optional(). Em PATCH, campos omitidos
// devem continuar omitidos para preservar a configuração existente.
export function partialInput(schema) {
  const defaults = Object.fromEntries(Object.entries(schema.shape)
    .filter(([, field]) => field instanceof z.ZodDefault)
    .map(([name, field]) => [name, field.removeDefault().optional()]));
  return schema.partial().extend(defaults);
}

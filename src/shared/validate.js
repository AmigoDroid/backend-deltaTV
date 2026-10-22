// Valida body/query/params com zod; resultado em req.valid (req.query é somente leitura no Express 5).
export const validate = (schemas) => (req, _res, next) => {
  req.valid = {};
  for (const part of ["params", "query", "body"]) {
    if (schemas[part]) req.valid[part] = schemas[part].parse(req[part] ?? {});
  }
  next();
};

// MAC é identificador de ativação, não prova de identidade (pode ser falsificado).
export function normalizeMac(value) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/[:.\s-]/g, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(compact)) return null;
  if (compact === "000000000000" || compact === "FFFFFFFFFFFF") return null;
  return compact.match(/.{2}/g).join(":");
}

/** Só dígitos hexadecimais: sem separadores, sem coringas de LIKE e, por isso, sem risco de injeção. */
export const macHex = (q) => String(q ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();

/**
 * Condição SQL de busca por MAC parcial, ignorando os dois-pontos ("aabb" encontra "AA:BB:CC:...").
 * Busca sem nenhum caractere hexadecimal não corresponde a MAC algum: devolve FALSE (e não "tudo").
 * `alias` é o nome do model na consulta (constante do código, ex.: "Device"); `escape` é o escape do Sequelize.
 */
export function macSearchSql(alias, q, escape) {
  if (!/^[A-Za-z_]+$/.test(alias)) throw new Error("alias inválido");
  const hex = macHex(q);
  if (!hex) return "FALSE";
  return `replace("${alias}"."mac", ':', '') LIKE ${escape(`%${hex}%`)}`;
}

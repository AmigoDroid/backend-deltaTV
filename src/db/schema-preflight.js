/** Falha rápida antes de abrir HTTP: não servir Pix sobre esquema antigo. */
export async function verifyRequiredSchema(sequelize) {
  const qi = sequelize.getQueryInterface();
  const required = {
    pix_refund_cases: ["id", "charge_id", "status", "amount_cents"],
    web_accesses: ["id", "status", "status_reason", "content_owner_partner_id", "source_partner_code_id"],
  };
  for (const [table, columns] of Object.entries(required)) {
    let schema;
    try { schema = await qi.describeTable(table); }
    catch (cause) {
      throw new Error(`Banco não migrado: falta a tabela ${table}. Execute npm run db:migrate ANTES de iniciar a API.`, { cause });
    }
    const missing = columns.filter((column) => !Object.hasOwn(schema, column));
    if (missing.length)
      throw new Error(`Banco não migrado: ${table} sem ${missing.join(", ")}. Execute npm run db:migrate.`);
  }
  return true;
}

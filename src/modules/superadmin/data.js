/** Encrypted logical backups. All SQL identifiers come from the current database catalogue. */
import crypto from "node:crypto";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { sha256 } from "../../shared/crypto.js";
import { AppError } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { readControls } from "./settings.js";
const scrypt = promisify(crypto.scrypt),
  MAX = 20 * 1024 * 1024;
const select = (text, replacements = {}, transaction) =>
  sequelize.query(text, { replacements, transaction, type: QueryTypes.SELECT });
const quote = (x) => sequelize.getQueryInterface().quoteIdentifier(x);
const skipped = new Set([
  "SequelizeMeta",
  "audit_logs",
  "auth_sessions",
  "device_sessions",
  "device_scoped_sessions",
  "impersonation_grants",
  "device_access_keys",
  "device_pairing_tokens",
  "login_history",
]);
async function schema(transaction) {
  return select(
    `SELECT table_name,column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema='public' AND t.table_type='BASE TABLE') ORDER BY table_name,ordinal_position`,
    {},
    transaction,
  );
}
async function constraints(transaction) {
  return select(
    `SELECT con.conname AS name,rel.relname AS "table",con.condeferrable AS deferrable,con.condeferred AS deferred FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname='public' AND con.contype='f' ORDER BY rel.relname,con.conname`,
    {},
    transaction,
  );
}
const fingerprint = (columns) => sha256(JSON.stringify(columns));
async function encrypt(payload, password) {
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX)
    throw new AppError(
      422,
      "BACKUP_LIMIT",
      "Backup excede 20 MB antes da compressão.",
    );
  const salt = crypto.randomBytes(16),
    iv = crypto.randomBytes(12),
    key = await scrypt(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(gzipSync(Buffer.from(JSON.stringify(payload)))),
    cipher.final(),
  ]);
  return {
    format: "deltatv-backup-v1",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
async function decrypt(envelope, password) {
  try {
    if (envelope.format !== "deltatv-backup-v1") throw Error();
    const salt = Buffer.from(envelope.salt, "base64"),
      iv = Buffer.from(envelope.iv, "base64"),
      tag = Buffer.from(envelope.tag, "base64"),
      data = Buffer.from(envelope.data, "base64");
    if (
      salt.length !== 16 ||
      iv.length !== 12 ||
      tag.length !== 16 ||
      data.length > MAX
    )
      throw Error();
    const key = await scrypt(password, salt, 32),
      cipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAuthTag(tag);
    return JSON.parse(
      gunzipSync(Buffer.concat([cipher.update(data), cipher.final()]), {
        maxOutputLength: MAX,
      }).toString(),
    );
  } catch {
    throw new AppError(
      422,
      "INVALID_BACKUP",
      "Backup inválido, grande demais ou senha incorreta.",
    );
  }
}
export async function exportData(password, actor) {
  const payload = await sequelize.transaction(
    { isolationLevel: "REPEATABLE READ" },
    async (transaction) => {
      const columns = await schema(transaction),
        tables = [...new Set(columns.map((c) => c.table_name))].filter(
          (t) => t !== "SequelizeMeta",
        ),
        data = {};
      let total = 0,
        size = 0;
      for (const table of tables) {
        const rows = await select(
          `SELECT * FROM ${quote(table)} LIMIT 50001`,
          {},
          transaction,
        );
        total += rows.length;
        size += Buffer.byteLength(JSON.stringify(rows));
        if (rows.length > 50000 || total > 50000 || size > MAX)
          throw new AppError(
            422,
            "BACKUP_LIMIT",
            "O banco excede o limite de 50 mil registros/20 MB. Use pg_dump para backup completo.",
          );
        data[table] = rows;
      }
      await audit({
        actor,
        action: "data.backup.export",
        entityType: "database",
        metadata: { tables: tables.length, records: total },
        transaction,
      });
      return {
        version: 1,
        schema: fingerprint(columns),
        encryption: sha256(env.encryptionKey).slice(0, 32),
        codePepper: sha256(env.codePepper).slice(0, 32),
        createdAt: new Date().toISOString(),
        data,
      };
    },
  );
  return {
    filename: `backup-${new Date().toISOString().slice(0, 10)}.delta.json`,
    backup: await encrypt(payload, password),
  };
}
async function checkedBackup(envelope, password, transaction) {
  const value = await decrypt(envelope, password),
    columns = await schema(transaction);
  if (
    value.version !== 1 ||
    value.schema !== fingerprint(columns) ||
    value.encryption !== sha256(env.encryptionKey).slice(0, 32) ||
    value.codePepper !== sha256(env.codePepper).slice(0, 32)
  )
    throw new AppError(
      409,
      "BACKUP_SCHEMA",
      "O backup exige a mesma versão do esquema e as mesmas ENCRYPTION_KEY e CODE_PEPPER.",
    );
  const byTable = new Map();
  for (const c of columns) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
    byTable.get(c.table_name).set(c.column_name, c.data_type);
  }
  let records = 0;
  for (const [table, rows] of Object.entries(value.data || {})) {
    if (!byTable.has(table) || !Array.isArray(rows))
      throw new AppError(422, "INVALID_BACKUP", "Tabela desconhecida.");
    records += rows.length;
    if (records > 50000)
      throw new AppError(422, "BACKUP_LIMIT", "Mais de 50 mil registros.");
    for (const row of rows)
      if (
        !row ||
        typeof row !== "object" ||
        Object.keys(row).some((c) => !byTable.get(table).has(c))
      )
        throw new AppError(422, "INVALID_BACKUP", "Coluna desconhecida.");
  }
  return { value, byTable };
}
export async function previewImport(backup, password) {
  const { value } = await checkedBackup(backup, password);
  return {
    createdAt: value.createdAt,
    tables: Object.entries(value.data).map(([table, rows]) => ({
      table,
      records: rows.length,
      imported: !skipped.has(table),
    })),
    notice:
      "Mescla por chave primária sem excluir registros. Sessões, auditoria e usuário atual são preservados. Contas importadas ficam desativadas. Exige manutenção e confirmação.",
  };
}
export async function importData(
  { backup, password, reason, expectedHash },
  actor,
) {
  if (!(await readControls()).maintenance)
    throw new AppError(
      409,
      "MAINTENANCE_REQUIRED",
      "Ative a manutenção antes de importar.",
    );
  if (sha256(JSON.stringify(backup)) !== expectedHash)
    throw new AppError(409, "BACKUP_CHANGED", "Refaça a prévia deste arquivo.");
  return sequelize.transaction(async (transaction) => {
    const { value, byTable } = await checkedBackup(
        backup,
        password,
        transaction,
      ),
      fks = await constraints(transaction);
    const keys = await select(
      `SELECT tc.table_name,kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema AND tc.table_name=kcu.table_name WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY' ORDER BY tc.table_name,kcu.ordinal_position`,
      {},
      transaction,
    );
    const byKey = new Map();
    for (const k of keys) {
      if (!byKey.has(k.table_name)) byKey.set(k.table_name, []);
      byKey.get(k.table_name).push(k.column_name);
    }
    for (const fk of fks)
      if (!fk.deferrable)
        await sequelize.query(
          `ALTER TABLE ${quote(fk.table)} ALTER CONSTRAINT ${quote(fk.name)} DEFERRABLE INITIALLY DEFERRED`,
          { transaction },
        );
    await sequelize.query("SET CONSTRAINTS ALL DEFERRED", { transaction });
    let imported = 0;
    for (const [table, rows] of Object.entries(value.data)) {
      if (skipped.has(table)) continue;
      const pk = byKey.get(table);
      if (!pk?.length && rows.length)
        throw new AppError(
          422,
          "NO_PRIMARY_KEY",
          `Tabela ${table} não suporta mesclagem segura. Use a restauração offline.`,
        );
      for (const original of rows) {
        if (table === "admin_users" && original.id === actor.id) continue;
        const row = { ...original };
        if (table === "platform_settings" && row.key === "superadmin.controls")
          row.value = { ...row.value, maintenance: true };
        if (table === "admin_users") {
          row.status = "disabled";
          row.token_version = Number(row.token_version || 0) + 1;
          row.password_reset_hash = null;
          row.password_reset_expires_at = null;
          row.password_reset_issued_at = null;
        }
        const cols = Object.keys(row),
          bind = {};
        cols.forEach(
          (col, i) =>
            (bind[`v${i}`] = ["json", "jsonb"].includes(
              byTable.get(table).get(col),
            )
              ? JSON.stringify(row[col])
              : row[col]),
        );
        const updates = cols
          .filter((c) => !pk.includes(c))
          .map((c) => `${quote(c)}=EXCLUDED.${quote(c)}`)
          .join(",");
        await sequelize.query(
          `INSERT INTO ${quote(table)} (${cols.map(quote).join(",")}) VALUES (${cols.map((_, i) => `$v${i}`).join(",")}) ON CONFLICT (${pk.map(quote).join(",")}) ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}`,
          { bind, transaction },
        );
        imported++;
      }
    }
    // Imported numeric primary keys must never collide with the next generated ID.
    const serials = await select(
      `SELECT table_name,column_name,pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) AS sequence FROM information_schema.columns WHERE table_schema='public' AND (column_default LIKE 'nextval(%' OR is_identity='YES')`,
      {},
      transaction,
    );
    for (const item of serials) {
      if (!item.sequence) continue;
      await sequelize.query(
        `SELECT setval(CAST(:sequence AS regclass),GREATEST(COALESCE((SELECT max(${quote(item.column_name)})::bigint FROM ${quote(item.table_name)}),1),COALESCE(pg_sequence_last_value(CAST(:sequence AS regclass)),1)),true)`,
        { replacements: { sequence: item.sequence }, transaction },
      );
    }
    await sequelize.query("SET CONSTRAINTS ALL IMMEDIATE", { transaction });
    for (const fk of fks)
      if (!fk.deferrable)
        await sequelize.query(
          `ALTER TABLE ${quote(fk.table)} ALTER CONSTRAINT ${quote(fk.name)} NOT DEFERRABLE`,
          { transaction },
        );
    // Invalidate all sessions except the source session by token version/status; imported users remain disabled.
    await audit({
      actor,
      action: "data.import",
      entityType: "database",
      metadata: { reason, imported, sourceDate: value.createdAt },
      transaction,
    });
    return { ok: true, imported };
  });
}
export const backupHash = (backup) => sha256(JSON.stringify(backup));

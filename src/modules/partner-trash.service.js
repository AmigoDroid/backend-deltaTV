/**
 * Lixeira do superadmin. Arquivamento reversível; eliminação física é um fluxo
 * separado, transacional e com bloqueio de cobranças/benefícios compartilhados.
 * Não tenta apagar dados de outra parceria, webhooks globais, backups ou provedores Pix.
 */
import { Op, QueryTypes, ForeignKeyConstraintError } from "sequelize";
import { sequelize, Partner, AdminUser } from "../db/models/index.js";
import { AppError, notFound } from "../shared/errors.js";
import { audit } from "../shared/audit.js";
import { clearMirrorAuth } from "./mirror/mirror.cache.js";
import { clearContractAccessCache } from "./access/access.service.js";
import { clearResolutionCache } from "./provider-monitor/resolve.service.js";
import { forgetDevice } from "./devices/presence.js";
import { disconnectPartner, broadcastChange } from "../realtime/socket.js";
import { matchesPartnerDeletionConfirmation } from "./partner-deletion-confirmation.js";
import { paged, pageOf } from "../shared/pagination.js";

function superOnly(actor) {
  if (actor?.role !== "superadmin") throw new AppError(403, "SUPERADMIN_ONLY", "Somente o superadmin pode usar a lixeira.");
}
const kindFilter = (kind) => kind === "content" || kind === "reseller" ? { [Op.in]: [kind, "both"] } : undefined;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const countDelete = async (sql, replacements, transaction) => {
  const result = await select(`WITH removed AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM removed`, replacements, transaction);
  return Number(result[0]?.n || 0);
};
// Atribuição por licença independente também é pertencimento comercial à revenda.
const OWN_LICENSE = `SELECT id FROM licenses WHERE owner_partner_id = :id`;
const OWN_CODE = `SELECT id FROM partner_codes WHERE partner_id = :id`;
const OWN_INVOICE = `SELECT id FROM invoices WHERE partner_id = :id`;
const OWN_ACTIVATION = `a.partner_id = :id OR a.license_id IN (${OWN_LICENSE}) OR
  a.granted_license_id IN (${OWN_LICENSE}) OR a.partner_code_id IN (${OWN_CODE})`;
const OWN_CHARGE = `partner_id = :id OR invoice_id IN (${OWN_INVOICE}) OR license_id IN (${OWN_LICENSE})`;

export async function listPartnerTrash({ page, pageSize, q, kind }, actor) {
  superOnly(actor);
  const where = { status: "deleted" };
  if (kindFilter(kind)) where.kind = kindFilter(kind);
  if (q) where[Op.or] = ["name", "slug", "contactName", "contactEmail"].map(field => ({ [field]: { [Op.iLike]: `%${q}%` } }));
  const { rows, count } = await Partner.findAndCountAll({
    where,
    attributes: ["id", "name", "slug", "kind", "contactEmail", "statusReason", "updatedAt", "createdAt"],
    order: [["updatedAt", "DESC"], ["id", "ASC"]], ...pageOf({ page, pageSize }),
  });
  const ids = rows.map(p => p.id);
  let known = new Set();
  if (ids.length) {
    const snapshots = await select(`SELECT partner_id FROM partner_trash_snapshots WHERE partner_id IN (:ids)`, { ids });
    known = new Set(snapshots.map(x => x.partner_id));
  }
  return paged(rows.map(p => ({ ...p.toJSON(), hasRestoreSnapshot: known.has(p.id) })), count, { page, pageSize });
}

async function previewInTransaction(id, transaction) {
  const [r] = await select(`SELECT
    (SELECT count(*)::int FROM admin_users WHERE partner_id = :id) AS "users",
    (SELECT count(*)::int FROM partner_codes WHERE partner_id = :id) AS "codes",
    (SELECT count(*)::int FROM partner_providers WHERE partner_id = :id) AS "providers",
    (SELECT count(*)::int FROM reseller_clients WHERE partner_id = :id) AS "clients",
    (SELECT count(*)::int FROM activations a WHERE ${OWN_ACTIVATION}) AS "activations",
    (SELECT count(*)::int FROM licenses WHERE owner_partner_id = :id) AS "licenses",
    (SELECT count(*)::int FROM web_accesses WHERE partner_id = :id) AS "webAccesses",
    (SELECT count(*)::int FROM invoices WHERE partner_id = :id) AS "invoices",
    (SELECT count(*)::int FROM payments WHERE invoice_id IN (${OWN_INVOICE}) OR license_id IN (${OWN_LICENSE})) AS "payments",
    (SELECT count(*)::int FROM pix_charges WHERE ${OWN_CHARGE}) AS "pixCharges",
    (SELECT count(*)::int FROM pix_refund_cases WHERE charge_id IN (SELECT id FROM pix_charges WHERE ${OWN_CHARGE}) AND status IN ('pending', 'receivable')) AS "openRefunds",
    (SELECT count(*)::int FROM pix_charges WHERE (${OWN_CHARGE}) AND status IN ('pending', 'review')) AS "openPix",
    (SELECT count(*)::int FROM license_stock_ledger WHERE partner_id = :id) AS "stockMovements",
    (SELECT count(*)::int FROM credit_ledger WHERE partner_id = :id) AS "creditMovements",
    (SELECT count(*)::int FROM license_stock WHERE partner_id = :id AND quantity <> 0) AS "stockBalances",
    (SELECT count(*)::int FROM credit_wallets WHERE partner_id = :id AND balance <> 0) AS "creditBalances",
    (SELECT count(*)::int FROM content_code_balances WHERE code_id IN (${OWN_CODE}) AND (allocated <> 0 OR spent <> 0)) AS "codeBalances",
    (SELECT count(*)::int FROM activations a WHERE (a.license_id IN (${OWN_LICENSE})
      OR a.granted_license_id IN (${OWN_LICENSE}) OR a.partner_code_id IN (${OWN_CODE}))
      AND a.partner_id IS NOT NULL AND a.partner_id <> :id) AS "otherPartnerActivations",
    (SELECT count(*)::int FROM web_accesses WHERE (content_owner_partner_id = :id
      OR source_partner_code_id IN (${OWN_CODE}))
      AND partner_id IS DISTINCT FROM :id) AS "otherPartnerWebAccesses",
    (SELECT count(*)::int FROM code_server_pools WHERE provider_id IN (SELECT id FROM partner_providers WHERE partner_id = :id)
      AND code_id NOT IN (${OWN_CODE})) AS "otherPartnerServerPools",
    (SELECT count(*)::int FROM licenses WHERE created_by IN (SELECT id FROM admin_users WHERE partner_id = :id)
      AND owner_partner_id IS DISTINCT FROM :id) AS "unownedCreatorLicenses",
    (SELECT count(*)::int FROM pix_charges WHERE created_by IN (SELECT id FROM admin_users WHERE partner_id = :id)
      AND NOT (${OWN_CHARGE})) AS "otherCreatorPixCharges",
    (SELECT count(*)::int FROM license_stock_ledger WHERE counterparty_partner_id = :id AND partner_id <> :id) AS "sharedStockReferences",
    EXISTS (SELECT 1 FROM partner_trash_snapshots WHERE partner_id = :id) AS "hasRestoreSnapshot"
  `, { id }, transaction);
  const response = {};
  for (const [key, value] of Object.entries(r)) response[key] = typeof value === "number" ? value : value;
  response.financialRecords = response.invoices + response.payments + response.pixCharges + response.stockMovements + response.creditMovements
    + response.stockBalances + response.creditBalances + response.codeBalances;
  response.blockers = [];
  if (response.openPix) response.blockers.push("Há cobranças Pix pendentes/em revisão. Concilie ou cancele no provedor antes.");
  if (response.openRefunds) response.blockers.push("Há devoluções pendentes. Resolva todos os casos no Financeiro antes.");
  if (response.otherPartnerActivations) response.blockers.push("Há ativações de outras parcerias usando códigos ou licenças deste cadastro.");
  if (response.otherPartnerWebAccesses) response.blockers.push("Há Player Web de outras parcerias dependentes deste parceiro de conteúdo.");
  if (response.otherPartnerServerPools) response.blockers.push("Outro parceiro está usando servidores deste cadastro no seu pool.");
  if (response.unownedCreatorLicenses) response.blockers.push("Há licenças criadas por seus usuários sem titularidade exclusiva comprovada; revise antes de apagar.");
  if (response.otherCreatorPixCharges) response.blockers.push("Há cobranças Pix criadas por seus usuários mas atribuídas a outra conta; revise antes.");
  return response;
}

export async function trashPreview(id, actor) {
  superOnly(actor);
  const partner = await Partner.findByPk(id, { attributes: ["id", "name", "slug", "kind", "status", "statusReason"] });
  if (!partner) throw notFound("Cadastro da lixeira");
  if (partner.status !== "deleted") throw new AppError(409, "NOT_IN_TRASH", "Arquive a parceria primeiro.");
  return { ...partner.toJSON(), ...(await previewInTransaction(id)),
    retainedOutsideDatabase: "Backups, e-mails já enviados e registros de provedores externos não são removidos.",
    sharedRecordsPreserved: "Dispositivos e movimentações de outras parcerias serão preservados.",
  };
}

function clearCaches(id, devices = []) {
  clearMirrorAuth(); clearContractAccessCache(); clearResolutionCache();
  for (const deviceId of devices) forgetDevice(deviceId);
  disconnectPartner(id);
  broadcastChange({ topic: "partners" }); broadcastChange({ topic: "devices" });
}

/** Restaura estados capturados antes de arquivar. Cadastros antigos sem snapshot
 * voltam BLOQUEADOS, com contas/códigos desligados, para revisão manual. */
export async function restorePartnerFromTrash(id, { reason }, actor) {
  superOnly(actor);
  if (!reason?.trim() || reason.trim().length < 8) throw new AppError(422, "REASON_REQUIRED", "Informe um motivo com pelo menos 8 caracteres.");
  const result = await sequelize.transaction(async transaction => {
    const partner = await Partner.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!partner) throw notFound("Cadastro da lixeira");
    if (partner.status !== "deleted") throw new AppError(409, "NOT_IN_TRASH", "Este cadastro não está na lixeira.");
    const [snapshot] = await select("SELECT * FROM partner_trash_snapshots WHERE partner_id = :id FOR UPDATE", { id }, transaction);
    const originalStatus = snapshot?.previous_status || "blocked";
    if (!["active", "suspended", "blocked", "cancelled"].includes(originalStatus)) throw new AppError(409, "INVALID_SNAPSHOT", "Fotografia de restauração inconsistente.");
    if (snapshot) {
      const restoreRows = async (table, field, extraSql = "") => {
        const archivedStatus = table === "admin_users" || table === "partner_providers" ? "disabled" : "revoked";
        await sequelize.query(`UPDATE ${table} item SET status = restore.status ${extraSql}
          FROM jsonb_to_recordset(CAST(:items AS jsonb)) AS restore(id uuid, status text, "statusReason" text)
          WHERE item.id = restore.id AND item.partner_id = :id AND item.status = :archivedStatus`,
        { replacements: { id, archivedStatus, items: JSON.stringify(snapshot[field] || []) }, transaction });
      };
      await restoreRows("admin_users", "users", ", token_version = item.token_version + 1");
      await restoreRows("partner_codes", "codes");
      await restoreRows("partner_providers", "providers");
      await restoreRows("web_accesses", "web_accesses", ", status_reason = restore.\"statusReason\"");
    }
    await partner.update({ status: originalStatus, statusReason: snapshot ? snapshot.previous_status_reason : "Restaurado da lixeira antiga: reativação manual necessária" }, { transaction });
    await sequelize.query("DELETE FROM partner_trash_snapshots WHERE partner_id = :id", { replacements: { id }, transaction });
    await audit({ actor, action: "partner.restore.admin", entityType: "partner", entityId: id,
      metadata: { originalStatus, usedSnapshot: Boolean(snapshot), reason: reason.trim() }, transaction });
    return { restored: true, id, status: originalStatus, needsManualReview: !snapshot };
  });
  clearCaches(id);
  return result;
}

/** EXCLUSÃO DEFINITIVA. Exige e-mail/slug de confirmação, consentimento adicional
 * para movimentações financeiras e ausência de pendências externas/compartilhamento.
 * Uma única transação: qualquer FK desconhecida provoca ROLLBACK, nunca purga parcial.
 */
export async function permanentlyDeletePartner(id, input, actor) {
  superOnly(actor);
  if (input.phrase !== "EXCLUIR DEFINITIVAMENTE") throw new AppError(422, "PURGE_PHRASE", "Digite EXCLUIR DEFINITIVAMENTE.");
  if (!input.reason?.trim() || input.reason.trim().length < 12) throw new AppError(422, "REASON_REQUIRED", "Informe um motivo com pelo menos 12 caracteres.");
  let result;
  try {
    result = await sequelize.transaction(async transaction => {
      const p = await Partner.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!p) throw notFound("Cadastro da lixeira");
      if (p.status !== "deleted") throw new AppError(409, "NOT_IN_TRASH", "Só é possível apagar permanentemente um cadastro arquivado.");
      if (!matchesPartnerDeletionConfirmation(input.confirmSlug, p)) throw new AppError(422, "CONFIRMATION_MISMATCH", "Confirme o identificador ou nome exato.");
      const preview = await previewInTransaction(id, transaction);
      if (preview.blockers.length) throw new AppError(409, "PURGE_BLOCKED", preview.blockers.join(" "));
      if (preview.financialRecords && input.purgeFinancialHistory !== true)
        throw new AppError(422, "FINANCIAL_CONFIRMATION_REQUIRED", "Confirme separadamente a remoção irreversível do histórico financeiro.");
      const replacements = { id };
      // Para não excluir uma TV compartilhada: fotografia somente dos dispositivos
      // ligados a ativações/web acessos próprios. A remoção de órfãos vem no fim.
      await sequelize.query(`CREATE TEMP TABLE deltatv_trash_devices (id uuid PRIMARY KEY) ON COMMIT DROP`, { transaction });
      await sequelize.query(`CREATE TEMP TABLE deltatv_trash_customers (id uuid PRIMARY KEY) ON COMMIT DROP`, { transaction });
      await sequelize.query(`INSERT INTO deltatv_trash_customers (id)
        SELECT DISTINCT customer_id FROM licenses WHERE owner_partner_id = :id AND customer_id IS NOT NULL`, { replacements, transaction });
      await sequelize.query(`INSERT INTO deltatv_trash_devices (id)
        SELECT DISTINCT a.device_id FROM activations a WHERE ${OWN_ACTIVATION}
        UNION SELECT DISTINCT device_id FROM web_accesses WHERE partner_id = :id`, { replacements, transaction });
      const deleted = {};
      const run = async (key, sql) => { deleted[key] = await countDelete(sql, replacements, transaction); };
      // Cobrança e lançamentos - filhos antes dos pais.
      await run("refundCases", `DELETE FROM pix_refund_cases WHERE charge_id IN (SELECT id FROM pix_charges WHERE ${OWN_CHARGE})`);
      await run("creditLedger", `DELETE FROM credit_ledger WHERE partner_id = :id`);
      await run("stockLedger", `DELETE FROM license_stock_ledger WHERE partner_id = :id`);
      await run("pixCharges", `DELETE FROM pix_charges WHERE ${OWN_CHARGE}`);
      await run("deviceTrials", `DELETE FROM device_trials WHERE license_id IN (${OWN_LICENSE})`);
      await run("renewals", `DELETE FROM renewals WHERE license_id IN (${OWN_LICENSE})`);
      await run("payments", `DELETE FROM payments WHERE invoice_id IN (${OWN_INVOICE}) OR license_id IN (${OWN_LICENSE})`);
      await run("invoices", `DELETE FROM invoices WHERE partner_id = :id`);
      // Catálogo e ativações: FKs com CASCADE/SET NULL fazem limpeza local.
      await run("activationCharges", `DELETE FROM content_activation_charges WHERE code_id IN (${OWN_CODE})`);
      await run("webAccesses", `DELETE FROM web_accesses WHERE partner_id = :id`);
      await run("activations", `DELETE FROM activations a WHERE ${OWN_ACTIVATION}`);
      // Licenças próprias, excluindo apenas as da revenda: planos globais preservados.
      await run("licenses", `DELETE FROM licenses WHERE owner_partner_id = :id`);
      // Cliente global é preservado se qualquer outra licença o utilizar.
      await run("orphanCustomers", `DELETE FROM customers c WHERE c.id IN (SELECT id FROM deltatv_trash_customers)
        AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.customer_id = c.id)`);
      // Pool, monitoramento e saldo de códigos.
      await run("codeBalances", `DELETE FROM content_code_balances WHERE code_id IN (${OWN_CODE})`);
      await run("activationChargesResidual", `DELETE FROM content_activation_charges WHERE code_id IN (${OWN_CODE})`);
      await run("codeServerPools", `DELETE FROM code_server_pools WHERE code_id IN (${OWN_CODE}) OR provider_id IN (SELECT id FROM partner_providers WHERE partner_id = :id)`);
      await run("codeFailovers", `DELETE FROM code_failovers WHERE code_id IN (${OWN_CODE})`);
      await run("codes", `DELETE FROM partner_codes WHERE partner_id = :id`);
      await run("providerEvents", `DELETE FROM provider_health_events WHERE provider_id IN (SELECT id FROM partner_providers WHERE partner_id = :id)`);
      await run("providerHealth", `DELETE FROM provider_health WHERE provider_id IN (SELECT id FROM partner_providers WHERE partner_id = :id)`);
      await run("providers", `DELETE FROM partner_providers WHERE partner_id = :id`);
      // Contratos, saldos, dados de conta e convites relacionados.
      await run("contentTerms", `DELETE FROM content_partner_terms WHERE partner_id = :id`);
      await run("servicePlans", `DELETE FROM partner_service_plans WHERE partner_id = :id`);
      await run("stock", `DELETE FROM license_stock WHERE partner_id = :id`);
      await run("wallets", `DELETE FROM credit_wallets WHERE partner_id = :id`);
      await run("clients", `DELETE FROM reseller_clients WHERE partner_id = :id`);
      await run("preRegistrations", `DELETE FROM partner_pre_registrations WHERE completed_partner_id = :id`);
      await run("loginHistory", `DELETE FROM login_history WHERE partner_id = :id
        OR admin_user_id IN (SELECT id FROM admin_users WHERE partner_id = :id)
        OR (role = 'partner' AND lower(user_email) IN (SELECT lower(email) FROM admin_users WHERE partner_id = :id))`);
      // Exclui destinatários pertencentes ao cadastro em mensagens compartilhadas;
      // os demais destinatários e a campanha administrativa continuam intactos.
      await run("emailDeliveries", `DELETE FROM email_deliveries WHERE lower(to_email) IN
        (SELECT lower(email) FROM admin_users WHERE partner_id = :id)`);
      // Mensagens emitidas por usuários apagados não devem sobreviver com sua autoria.
      await run("emails", `DELETE FROM email_messages WHERE created_by IN (SELECT id FROM admin_users WHERE partner_id = :id)`);
      // Histórico da conta: limpar eventos anteriores; preservar apenas trilha mínima da exclusão.
      await run("auditHistory", `DELETE FROM audit_logs WHERE entity_id = CAST(:id AS text)
        OR actor_id IN (SELECT id::text FROM admin_users WHERE partner_id = :id)
        OR entity_id IN (SELECT id::text FROM admin_users WHERE partner_id = :id)
        OR metadata->>'actorPartnerId' = CAST(:id AS text)`);
      await run("users", `DELETE FROM admin_users WHERE partner_id = :id`);
      // Trials de aparelhos realmente órfãos não devem reter MAC após a exclusão.
      await run("orphanDeviceTrials", `DELETE FROM device_trials WHERE mac IN (SELECT d.mac FROM devices d
        WHERE d.id IN (SELECT id FROM deltatv_trash_devices)
        AND NOT EXISTS (SELECT 1 FROM activations a WHERE a.device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM web_accesses w WHERE w.device_id = d.id))`);
      // A TV só é apagada quando não há mais ativações nem WebAccess de qualquer parceiro.
      await run("orphanDevices", `DELETE FROM devices d WHERE d.id IN (SELECT id FROM deltatv_trash_devices)
        AND NOT EXISTS (SELECT 1 FROM activations a WHERE a.device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM web_accesses w WHERE w.device_id = d.id)`);
      deleted.partner = await countDelete("DELETE FROM partners WHERE id = :id", replacements, transaction);
      if (deleted.partner !== 1) throw new AppError(409, "PURGE_INCOMPLETE", "Cadastro não foi removido; a transação será revertida.");
      // Sem dados de contato/slug no log; só ID, totais, ator e justificativa.
      await audit({ actor, action: "partner.purge.admin", entityType: "partner", entityId: id,
        metadata: { kind: p.kind, deleted, reason: input.reason.trim(), irreversivel: true }, transaction });
      return { permanentlyDeleted: true, id, deleted };
    });
  } catch (error) {
    if (error instanceof ForeignKeyConstraintError || error?.parent?.code === "23503")
      throw new AppError(409, "PURGE_REFERENCES", "Existem registros vinculados que não podem ser apagados com segurança. Nada foi excluído; revise as dependências e tente novamente.");
    throw error;
  }
  clearCaches(id);
  return result;
}

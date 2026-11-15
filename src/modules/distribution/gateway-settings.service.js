import { AdminUser, Partner, sequelize } from '../../db/models/index.js';
import { audit } from '../../shared/audit.js';
import { encryptSecret, verifyPassword } from '../../shared/crypto.js';
import { env } from '../../config/env.js';
import { requireMaster } from './network.service.js';
import { select, exec, fail, GLOBAL_LOCK } from './master-pix.core.js';
import { GATEWAY_PROVIDERS, GATEWAY_LABELS, isProvider } from './gateways/index.js';
import { HANDLE_RE, normalizeHandle } from './gateways/infinitepay.js';
import { normalizePixKey } from './gateways/brcode.js';

const API_KEY_RE = /^inchk_[A-Za-z0-9_-]{8,200}$/;
const NAME_RE = /^[\p{L}0-9 .'-]{2,25}$/u;
const livePayments = async (partnerId, provider, t) => Number((await select(`SELECT count(*)::int AS n FROM reseller_master_pix_orders
  WHERE seller_partner_id=:id AND provider=:provider AND status IN ('creating','pending')`, { id: partnerId, provider }, t))[0]?.n || 0);

async function confirmIdentity(actor, currentPassword) {
  const author = actor?.id ? await AdminUser.findByPk(actor.id) : null;
  if (!author || author.status !== 'active' || !(await verifyPassword(currentPassword, author.passwordHash)))
    throw fail(403, 'PASSWORD_CONFIRMATION_REQUIRED', 'Senha da sua conta incorreta. Confirme sua identidade para alterar recebimentos.');
}
const assertSeller = async (partnerId, t, admin) => {
  if (!admin) return requireMaster(partnerId, 'canSell', t);
  const target = await Partner.findByPk(partnerId, { transaction: t });
  if (!target || target.distributionRole !== 'master') throw fail(403, 'NOT_MASTER', 'Conta não é Master.');
};

/** Visão única dos três meios de recebimento. Nunca devolve token, chave de API nem segredos. */
export async function listGateways(sellerId, { admin = false } = {}) {
  await assertSeller(sellerId, undefined, admin);
  const rows = await select(`SELECT provider,account_ref,receiver_name,receiver_city,active,(access_token_enc IS NOT NULL) AS has_secret
    FROM reseller_payment_gateways WHERE partner_id=:id`, { id: sellerId });
  const counts = await select(`SELECT provider,count(*)::int AS n FROM reseller_master_pix_orders
    WHERE seller_partner_id=:id AND status IN ('creating','pending','review') GROUP BY provider`, { id: sellerId });
  return GATEWAY_PROVIDERS.map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    return {
      provider, label: GATEWAY_LABELS[provider], configured: !!row, enabled: !!row?.active,
      accountRef: row?.account_ref ?? null, receiverName: row?.receiver_name ?? null, receiverCity: row?.receiver_city ?? null,
      hasApiKey: provider === 'infinitepay' ? !!row?.has_secret : undefined,
      webhookUrl: provider === 'mercadopago' ? `${env.publicBaseUrl}/api/v1/webhooks/master-pix/mercadopago/${sellerId}` : undefined,
      pendingPayments: Number(counts.find((c) => c.provider === provider)?.n || 0),
    };
  });
}

async function upsert(sellerId, provider, fields, actor, admin, audited) {
  return sequelize.transaction(async (t) => {
    await exec(GLOBAL_LOCK, {}, t);
    await assertSeller(sellerId, t, admin);
    if (await livePayments(sellerId, provider, t)) throw fail(409, 'GATEWAY_PENDING_PAYMENTS', 'Existem cobranças pendentes neste meio. Conclua ou aguarde expirar antes de trocar os dados.');
    await exec(`INSERT INTO reseller_payment_gateways(partner_id,provider,access_token_enc,webhook_secret_enc,account_ref,receiver_name,receiver_city,active)
      VALUES(:id,:provider,:secret,NULL,:ref,:name,:city,:active)
      ON CONFLICT(partner_id,provider) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc,account_ref=EXCLUDED.account_ref,
        receiver_name=EXCLUDED.receiver_name,receiver_city=EXCLUDED.receiver_city,active=EXCLUDED.active,updated_at=now()`,
    { id: sellerId, provider, secret: fields.secretEnc ?? null, ref: fields.ref, name: fields.name ?? null, city: fields.city ?? null, active: fields.active }, t);
    await audit({ actor, action: 'distribution.pix.gateway.configured', entityType: 'partner', entityId: sellerId, metadata: { provider, enabled: fields.active, ...audited }, transaction: t });
  });
}

export async function saveInfinitePay(sellerId, { handle, apiKey, currentPassword, active = true }, actor, { admin = false } = {}) {
  await confirmIdentity(actor, currentPassword);
  const clean = normalizeHandle(handle);
  if (!HANDLE_RE.test(clean)) throw fail(422, 'INVALID_HANDLE', 'InfiniteTag inválida. Informe o nome de usuário da conta InfinitePay, sem o $.');
  if (apiKey && !API_KEY_RE.test(apiKey)) throw fail(422, 'INVALID_API_KEY', 'Chave de API da InfinitePay inválida (ela começa com inchk_).');
  const existing = (await select(`SELECT access_token_enc FROM reseller_payment_gateways WHERE partner_id=:id AND provider='infinitepay'`, { id: sellerId }))[0];
  const secretEnc = apiKey === undefined ? (existing?.access_token_enc ?? null) : (apiKey ? encryptSecret(apiKey) : null);
  await upsert(sellerId, 'infinitepay', { ref: clean, secretEnc, active }, actor, admin, { handle: clean, hasApiKey: !!secretEnc });
  return (await listGateways(sellerId, { admin })).find((g) => g.provider === 'infinitepay');
}

export async function saveManualPix(sellerId, { keyType, key, receiverName, receiverCity, currentPassword, active = true }, actor, { admin = false } = {}) {
  await confirmIdentity(actor, currentPassword);
  const normalized = normalizePixKey(keyType, key);
  if (!normalized) throw fail(422, 'INVALID_PIX_KEY', 'Chave Pix inválida para o tipo escolhido.');
  if (!NAME_RE.test(String(receiverName ?? '').trim())) throw fail(422, 'INVALID_RECEIVER_NAME', 'Informe o nome do recebedor (2 a 25 caracteres), igual ao da conta bancária.');
  if (!NAME_RE.test(String(receiverCity ?? '').trim()) || String(receiverCity).trim().length > 15) throw fail(422, 'INVALID_RECEIVER_CITY', 'Informe a cidade do recebedor (até 15 caracteres).');
  await upsert(sellerId, 'manual_pix', { ref: normalized, name: String(receiverName).trim(), city: String(receiverCity).trim(), active }, actor, admin, { keyType });
  return (await listGateways(sellerId, { admin })).find((g) => g.provider === 'manual_pix');
}

export async function setGatewayActive(sellerId, provider, active, actor, { admin = false } = {}) {
  if (!isProvider(provider)) throw fail(422, 'INVALID_PROVIDER', 'Meio de pagamento desconhecido.');
  await sequelize.transaction(async (t) => {
    await exec(GLOBAL_LOCK, {}, t);
    await assertSeller(sellerId, t, admin);
    const rows = await select(`UPDATE reseller_payment_gateways SET active=:active,updated_at=now() WHERE partner_id=:id AND provider=:provider RETURNING provider`, { id: sellerId, provider, active }, t);
    if (!rows.length) throw fail(409, 'GATEWAY_NOT_CONFIGURED', 'Configure este meio antes de ativar as vendas.');
    await audit({ actor, action: 'distribution.pix.gateway.status', entityType: 'partner', entityId: sellerId, metadata: { provider, active }, transaction: t });
  });
  return { provider, enabled: active };
}

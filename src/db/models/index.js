import { DataTypes as T } from "sequelize";
import { sequelize } from "../sequelize.js";

const uuid = () => ({ type: T.UUID, primaryKey: true, defaultValue: T.UUIDV4 });
const def = (name, table, attrs, options = {}) =>
  sequelize.define(name, { id: uuid(), ...attrs }, { tableName: table, ...options });
const str = (n, extra = {}) => ({ type: T.STRING(n), ...extra });
const ts = () => ({ type: T.DATE });
const int = (def, extra = {}) => ({ type: T.INTEGER, allowNull: false, defaultValue: def, ...extra });

export const Plan = def("Plan", "plans", {
  code: str(40, { allowNull: false }), name: str(120, { allowNull: false }),
  durationMonths: { type: T.INTEGER, allowNull: false }, maxDevices: int(1),
  priceCents: int(0), active: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
});

export const Partner = def("Partner", "partners", {
  name: str(160, { allowNull: false }), slug: str(60, { allowNull: false }),
  contactName: str(160), contactEmail: str(200), contactPhone: str(40),
  status: str(20, { allowNull: false, defaultValue: "active" }), statusReason: str(500),
  startsAt: { ...ts(), allowNull: false }, endsAt: { ...ts(), allowNull: false },
  billingModel: str(20, { allowNull: false, defaultValue: "fixed" }),
  monthlyFeeCents: int(0), perDeviceCents: int(0), minFeeCents: int(0),
  tiers: { type: T.JSONB, allowNull: false, defaultValue: [] },
  deviceLimit: { type: T.INTEGER }, dueDay: int(10), graceDays: int(5),
  suspendPolicy: str(20, { allowNull: false, defaultValue: "auto_after_grace" }), notes: T.TEXT,
  // content = fornece conteúdo; reseller = compra/distribui licenças e edita dispositivos por MAC; both = os dois.
  kind: str(10, { allowNull: false, defaultValue: "content" }),
});

export const AdminUser = def("AdminUser", "admin_users", {
  name: str(160, { allowNull: false }), email: str(200, { allowNull: false }),
  passwordHash: { type: T.TEXT, allowNull: false }, role: str(20, { allowNull: false }),
  partnerId: { type: T.UUID }, status: str(20, { allowNull: false, defaultValue: "active" }),
  failedLogins: int(0), lockedUntil: ts(), tokenVersion: int(0), lastLoginAt: ts(),
});

export const AuthSession = def("AuthSession", "auth_sessions", {
  adminUserId: { type: T.UUID, allowNull: false }, refreshHash: { type: T.CHAR(64), allowNull: false },
  expiresAt: { ...ts(), allowNull: false }, revokedAt: ts(), ip: str(64), userAgent: str(300),
});

export const Customer = def("Customer", "customers", {
  name: str(160, { allowNull: false }), email: str(200), phone: str(40), notes: T.TEXT,
});

export const License = def("License", "licenses", {
  codeHash: { type: T.CHAR(64), allowNull: false }, codeLast4: str(4, { allowNull: false }),
  planId: { type: T.UUID, allowNull: false }, customerId: { type: T.UUID },
  status: str(20, { allowNull: false, defaultValue: "active" }), statusReason: str(500),
  startsAt: ts(), expiresAt: ts(), maxDevices: int(1), notes: T.TEXT, createdBy: { type: T.UUID },
  // Revendedor dono do estoque (NULL = licença da plataforma). Migration 20261018000004.
  ownerPartnerId: { type: T.UUID }, assignedAt: ts(),
});

export const PartnerCode = def("PartnerCode", "partner_codes", {
  partnerId: { type: T.UUID, allowNull: false }, code: str(12, { allowNull: false }), label: str(120),
  status: str(20, { allowNull: false, defaultValue: "active" }),
  maxActivations: { type: T.INTEGER }, expiresAt: ts(), createdBy: { type: T.UUID },
  // Servidor (partner_providers) para o qual este código aponta. NULL = código antigo: testa os servidores do parceiro.
  providerId: { type: T.UUID },
  // Duração (meses) da licença do ESTOQUE do dono que este código consome ao ativar um dispositivo. NULL = código sem licença.
  licenseMonths: { type: T.INTEGER },
});

export const PartnerProvider = def("PartnerProvider", "partner_providers", {
  partnerId: { type: T.UUID, allowNull: false }, name: str(120, { allowNull: false }),
  baseUrl: str(500, { allowNull: false }), playlistTemplate: str(500, { allowNull: false }),
  deliveryMode: str(20, { allowNull: false, defaultValue: "redirect" }), priority: int(0),
  status: str(20, { allowNull: false, defaultValue: "active" }),
});

export const Device = def("Device", "devices", {
  mac: { type: T.CHAR(17) }, lastInstallationId: str(100), lastSeenAt: ts(),
  // Multiplataforma (migration 20261018000001). device_key é preenchida por gatilho quando só o MAC é informado.
  platform: str(20, { allowNull: false, defaultValue: "roku" }), appId: str(64, { allowNull: false, defaultValue: "delta-tv-roku" }),
  identifierType: str(20, { allowNull: false, defaultValue: "virtual_mac" }), deviceKey: str(160),
  appVersion: str(40), firstRegisteredAt: ts(), secretHash: { type: T.CHAR(64) }, installationChangedAt: ts(),
  // Lista por link enviada pelo site enquanto o MAC não tem licença (migration 20261031000001). Passa para a ativação ao licenciar.
  pendingPlaylistName: str(160), pendingPlaylistUrlEnc: T.TEXT, pendingPlaylistAt: ts(),
});

export const Activation = def("Activation", "activations", {
  deviceId: { type: T.UUID, allowNull: false }, mac: { type: T.CHAR(17) },
  installationId: str(100), licenseId: { type: T.UUID }, partnerId: { type: T.UUID },
  partnerCodeId: { type: T.UUID }, providerId: { type: T.UUID }, credentialsEnc: T.TEXT,
  playlistName: str(160), playlistUrlEnc: T.TEXT,
  status: str(20, { allowNull: false, defaultValue: "active" }),
  statusReason: str(500), blockedBy: str(20), activatedAt: { ...ts(), allowNull: false, defaultValue: T.NOW },
  revokedAt: ts(), claimPending: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
  idempotencyKey: str(140),
  // Licença concedida a esta ativação a partir do estoque do revendedor (migration 20261027000001). Diferente de licenseId,
  // que é a licença individual com lista própria.
  grantedLicenseId: { type: T.UUID },
  // Modo de entrega definido pelo superadmin para ESTA ativação (migration 20261101000001). NULL = automático (ver mirror/mode.js).
  deliveryMode: str(20),
});

export const DevicePairingToken = def("DevicePairingToken", "device_pairing_tokens", {
  deviceId: { type: T.UUID, allowNull: false },
  tokenHash: { type: T.CHAR(64), allowNull: false, unique: true },
  tokenEnc: { type: T.TEXT, allowNull: false },
  registrationHash: { type: T.CHAR(64), allowNull: false },
  registrationEnc: { type: T.TEXT, allowNull: false },
  expiresAt: { ...ts(), allowNull: false },
  usedAt: ts(),
  registrationUsedAt: ts(),
  attempts: int(0),
});

export const DeviceAccessKey = def("DeviceAccessKey", "device_access_keys", {
  deviceId: { type: T.UUID, allowNull: false }, keyHash: { type: T.CHAR(64), allowNull: false },
  expiresAt: { ...ts(), allowNull: false }, attempts: int(0), usedAt: ts(), invalidatedAt: ts(), requestedIp: str(64),
});
export const DeviceScopedSession = def("DeviceScopedSession", "device_scoped_sessions", {
  deviceId: { type: T.UUID, allowNull: false }, tokenHash: { type: T.CHAR(64), allowNull: false },
  expiresAt: { ...ts(), allowNull: false }, revokedAt: ts(), ip: str(64), userAgent: str(300),
});

export const DeviceSession = def("DeviceSession", "device_sessions", {
  activationId: { type: T.UUID, allowNull: false }, refreshHash: { type: T.CHAR(64), allowNull: false },
  expiresAt: { ...ts(), allowNull: false }, revokedAt: ts(), lastUsedAt: ts(), ip: str(64), userAgent: str(300),
});

export const ContentSource = def("ContentSource", "content_sources", {
  name: str(160, { allowNull: false }), kind: str(20, { allowNull: false, defaultValue: "playlist" }),
  scope: str(20, { allowNull: false, defaultValue: "partner" }), urlEnc: T.TEXT, host: str(255),
  deliveryMode: str(20, { allowNull: false, defaultValue: "redirect" }),
  signing: { type: T.JSONB, allowNull: false, defaultValue: {} },
  status: str(20, { allowNull: false, defaultValue: "active" }), notes: T.TEXT, createdBy: { type: T.UUID },
});

export const Category = def("Category", "categories", {
  sourceId: { type: T.UUID, allowNull: false }, name: str(160, { allowNull: false }), sortOrder: int(0),
});

export const Channel = def("Channel", "channels", {
  sourceId: { type: T.UUID, allowNull: false }, categoryId: { type: T.UUID }, externalId: str(120),
  name: str(200, { allowNull: false }), kind: str(20, { allowNull: false, defaultValue: "live" }),
  streamUrlEnc: { type: T.TEXT, allowNull: false }, logoUrl: T.TEXT,
  status: str(20, { allowNull: false, defaultValue: "active" }), sortOrder: int(0),
});

export const PartnerSource = sequelize.define(
  "PartnerSource",
  { partnerId: { type: T.UUID, primaryKey: true }, sourceId: { type: T.UUID, primaryKey: true } },
  { tableName: "partner_sources" },
);

export const Invoice = def("Invoice", "invoices", {
  partnerId: { type: T.UUID, allowNull: false }, competence: { type: T.CHAR(7), allowNull: false },
  deviceCount: int(0), amountCents: { type: T.INTEGER, allowNull: false }, paidCents: int(0),
  dueDate: { type: T.DATEONLY, allowNull: false }, status: str(20, { allowNull: false, defaultValue: "open" }),
  paidAt: ts(), breakdown: { type: T.JSONB, allowNull: false, defaultValue: {} },
});

export const Payment = def("Payment", "payments", {
  invoiceId: { type: T.UUID }, licenseId: { type: T.UUID },
  amountCents: { type: T.INTEGER, allowNull: false }, method: str(30),
  provider: str(30, { allowNull: false, defaultValue: "manual" }), providerRef: str(120),
  origin: str(20, { allowNull: false }), status: str(20, { allowNull: false, defaultValue: "confirmed" }),
  confirmedBy: { type: T.UUID }, note: str(500), paidAt: { ...ts(), allowNull: false, defaultValue: T.NOW },
});

export const Renewal = def("Renewal", "renewals", {
  licenseId: { type: T.UUID, allowNull: false }, planId: { type: T.UUID, allowNull: false },
  previousExpiresAt: ts(), newExpiresAt: { ...ts(), allowNull: false },
  paymentId: { type: T.UUID }, createdBy: { type: T.UUID },
});

// Estoque de licenças do revendedor (migration 20261026000001). O saldo é gravado por SQL atômico (stock.service.js).
export const LicenseStockLedger = def("LicenseStockLedger", "license_stock_ledger", {
  partnerId: { type: T.UUID, allowNull: false }, months: { type: T.INTEGER, allowNull: false },
  delta: { type: T.INTEGER, allowNull: false }, balanceAfter: { type: T.INTEGER, allowNull: false },
  kind: str(16, { allowNull: false }), counterpartyPartnerId: { type: T.UUID }, transferId: { type: T.UUID },
  deviceId: { type: T.UUID }, licenseId: { type: T.UUID }, unitPriceCents: { type: T.INTEGER },
  note: str(500), actorUserId: { type: T.UUID }, actorName: str(160),
}, { updatedAt: false });

// Histórico imutável de uma licença (tabela license_events, migration 20261018000004): compra, ativação, transferência...
export const LicenseEvent = def("LicenseEvent", "license_events", {
  licenseId: { type: T.UUID, allowNull: false }, partnerId: { type: T.UUID },
  event: str(16, { allowNull: false }), fromDeviceId: { type: T.UUID }, toDeviceId: { type: T.UUID },
  actorType: str(12, { allowNull: false }), actorId: { type: T.UUID },
  metadata: { type: T.JSONB, allowNull: false, defaultValue: {} },
}, { updatedAt: false });

// Pix (migration 20261028000001): tabela de preços das licenças e cobranças (QR Codes) geradas.
export const LicensePrice = def("LicensePrice", "license_prices", {
  partnerId: { type: T.UUID }, months: { type: T.INTEGER, allowNull: false },
  priceCents: { type: T.INTEGER, allowNull: false }, active: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
});

// Crédito pré-pago do revendedor (migration 20261104000001). O saldo fica em credit_wallets (SQL atômico em credits/credit-ledger.js).
export const CreditLedger = def("CreditLedger", "credit_ledger", {
  partnerId: { type: T.UUID, allowNull: false }, kind: str(16, { allowNull: false }),
  delta: { type: T.BIGINT, allowNull: false }, balanceAfter: { type: T.BIGINT, allowNull: false },
  rateCents: { type: T.INTEGER }, months: { type: T.INTEGER }, quantity: { type: T.INTEGER }, unitPriceCredits: { type: T.INTEGER },
  chargeId: { type: T.UUID }, note: str(300), actorUserId: { type: T.UUID }, actorName: str(160),
}, { updatedAt: false });
export const CreditRate = def("CreditRate", "credit_rates", { partnerId: { type: T.UUID }, rateCents: { type: T.INTEGER, allowNull: false } });
export const CreditPrice = def("CreditPrice", "credit_prices", {
  partnerId: { type: T.UUID }, months: { type: T.INTEGER, allowNull: false }, priceCredits: { type: T.INTEGER, allowNull: false },
  active: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
});

export const PixCharge = def("PixCharge", "pix_charges", {
  // partnerId NULL = compra de licença pelo site (purpose 'license')
  partnerId: { type: T.UUID },
  purpose: str(10, { allowNull: false }),
  invoiceId: { type: T.UUID },
  months: { type: T.INTEGER }, quantity: { type: T.INTEGER }, unitPriceCents: { type: T.INTEGER },
  amountCents: { type: T.INTEGER, allowNull: false }, provider: str(30, { allowNull: false }), providerRef: str(120),
  status: str(16, { allowNull: false, defaultValue: "pending" }),
  qrCode: { type: T.TEXT }, qrCodeBase64: { type: T.TEXT }, ticketUrl: { type: T.TEXT },
  expiresAt: { ...ts(), allowNull: false }, paidAt: ts(), paidAmountCents: { type: T.INTEGER }, fulfilledAt: ts(),
  paymentId: { type: T.UUID }, error: str(500), createdBy: { type: T.UUID }, lastCheckedAt: ts(),
  // Compra pelo site (migration 20261102000001): TV que recebe a licença, e-mail de quem paga e licença criada/renovada.
  mac: { type: T.CHAR(17) }, payerEmail: str(200), licenseId: { type: T.UUID },
});

// Clientes do revendedor (migration 20261029000001): agenda privada por MAC (nome, contato, valor, vencimento).
export const ResellerClient = def("ResellerClient", "reseller_clients", {
  partnerId: { type: T.UUID, allowNull: false }, mac: { type: T.CHAR(17), allowNull: false },
  name: str(160, { allowNull: false }), phone: str(30), address: str(300),
  priceCents: { type: T.INTEGER }, dueDate: { type: T.DATEONLY }, notes: str(500),
});

export const WebhookEvent = def("WebhookEvent", "webhook_events", {
  provider: str(30, { allowNull: false }), eventId: str(120, { allowNull: false }),
  payload: { type: T.JSONB, allowNull: false }, status: str(20, { allowNull: false, defaultValue: "received" }),
  error: T.TEXT, processedAt: ts(),
});

export const AuditLog = sequelize.define(
  "AuditLog",
  {
    id: { type: T.BIGINT, primaryKey: true, autoIncrement: true },
    actorType: { type: T.STRING(20), allowNull: false }, actorId: T.STRING(64),
    action: { type: T.STRING(80), allowNull: false }, entityType: T.STRING(40), entityId: T.STRING(64),
    result: { type: T.STRING(10), allowNull: false, defaultValue: "success" }, ip: T.STRING(64),
    metadata: { type: T.JSONB, allowNull: false, defaultValue: {} },
  },
  { tableName: "audit_logs", updatedAt: false },
);

/* ---------- Associações ---------- */
Plan.hasMany(License, { foreignKey: "planId" });
License.belongsTo(Plan, { foreignKey: "planId" });
Customer.hasMany(License, { foreignKey: "customerId" });
License.belongsTo(Customer, { foreignKey: "customerId" });
License.hasMany(Activation, { foreignKey: "licenseId" });
Activation.belongsTo(License, { foreignKey: "licenseId" });
Activation.belongsTo(License, { foreignKey: "grantedLicenseId", as: "GrantedLicense" });
// Ativações cuja licença veio do estoque do revendedor (granted_license_id): sem isto a licença nunca "enxerga" o aparelho.
License.hasMany(Activation, { foreignKey: "grantedLicenseId", as: "GrantedActivations" });
License.belongsTo(Partner, { foreignKey: "ownerPartnerId", as: "Owner" });
License.hasMany(LicenseEvent, { foreignKey: "licenseId" });
LicenseEvent.belongsTo(License, { foreignKey: "licenseId" });
Partner.hasMany(Activation, { foreignKey: "partnerId" });
Activation.belongsTo(Partner, { foreignKey: "partnerId" });
Partner.hasMany(PartnerProvider, { foreignKey: "partnerId" });
PartnerProvider.belongsTo(Partner, { foreignKey: "partnerId" });
PartnerProvider.hasMany(Activation, { foreignKey: "providerId" });
Activation.belongsTo(PartnerProvider, { foreignKey: "providerId" });
Partner.hasMany(PartnerCode, { foreignKey: "partnerId" });
PartnerCode.belongsTo(Partner, { foreignKey: "partnerId" });
PartnerCode.hasMany(Activation, { foreignKey: "partnerCodeId" });
Activation.belongsTo(PartnerCode, { foreignKey: "partnerCodeId" });
LicenseStockLedger.belongsTo(Partner, { foreignKey: "partnerId" });
LicenseStockLedger.belongsTo(Partner, { foreignKey: "counterpartyPartnerId", as: "counterparty" });
PartnerProvider.hasMany(PartnerCode, { foreignKey: "providerId" });
PartnerCode.belongsTo(PartnerProvider, { foreignKey: "providerId", as: "provider" });
Device.hasMany(Activation, { foreignKey: "deviceId" });
Activation.belongsTo(Device, { foreignKey: "deviceId" });
Device.hasMany(DevicePairingToken, { foreignKey: "deviceId" });
DevicePairingToken.belongsTo(Device, { foreignKey: "deviceId" });
Activation.hasMany(DeviceSession, { foreignKey: "activationId" });
DeviceSession.belongsTo(Activation, { foreignKey: "activationId" });
Partner.hasMany(Invoice, { foreignKey: "partnerId" });
Invoice.belongsTo(Partner, { foreignKey: "partnerId" });
Invoice.hasMany(Payment, { foreignKey: "invoiceId" });
Payment.belongsTo(Invoice, { foreignKey: "invoiceId" });
License.hasMany(Payment, { foreignKey: "licenseId" });
Payment.belongsTo(License, { foreignKey: "licenseId" });
Partner.hasMany(ResellerClient, { foreignKey: "partnerId" });
ResellerClient.belongsTo(Partner, { foreignKey: "partnerId" });
Partner.hasMany(PixCharge, { foreignKey: "partnerId" });
PixCharge.belongsTo(Partner, { foreignKey: "partnerId" });
Invoice.hasMany(PixCharge, { foreignKey: "invoiceId" });
PixCharge.belongsTo(Invoice, { foreignKey: "invoiceId" });
LicensePrice.belongsTo(Partner, { foreignKey: "partnerId" });
CreditLedger.belongsTo(Partner, { foreignKey: "partnerId" });
CreditRate.belongsTo(Partner, { foreignKey: "partnerId" });
CreditPrice.belongsTo(Partner, { foreignKey: "partnerId" });
License.hasMany(Renewal, { foreignKey: "licenseId" });
Renewal.belongsTo(License, { foreignKey: "licenseId" });
Renewal.belongsTo(Plan, { foreignKey: "planId" });
AdminUser.belongsTo(Partner, { foreignKey: "partnerId" });
AdminUser.hasMany(AuthSession, { foreignKey: "adminUserId" });
ContentSource.hasMany(Category, { foreignKey: "sourceId" });
ContentSource.hasMany(Channel, { foreignKey: "sourceId" });
Category.hasMany(Channel, { foreignKey: "categoryId" });
Channel.belongsTo(Category, { foreignKey: "categoryId" });
Channel.belongsTo(ContentSource, { foreignKey: "sourceId" });
ContentSource.belongsToMany(Partner, { through: PartnerSource, foreignKey: "sourceId", otherKey: "partnerId" });
Partner.belongsToMany(ContentSource, { through: PartnerSource, foreignKey: "partnerId", otherKey: "sourceId" });

export { sequelize };

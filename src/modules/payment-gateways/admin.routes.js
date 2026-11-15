import { Router } from 'express';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { paymentSettings } from '../partner-portal-sales/checkout.service.js';
import { runtimePixConfig } from '../pix/providers/index.js';
import { webhookCatalog, safePublicOrigin } from './overview.js';

/** Diagnóstico de configuração, não um teste externo de recebimento. Nenhum segredo sai da API. */
const router = Router();
router.use((req, res, next) => {
  if (req.user?.role !== 'superadmin' || req.impersonator)
    throw new AppError(403, 'SUPERADMIN_ONLY', 'Configurações globais são exclusivas do Superadmin.');
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/overview', async (_req, res) => {
  // A configuração comercial e a configuração Pix antiga são independentes:
  // uma migração pendente não deve ocultar a informação do outro módulo.
  const [portalResult, legacyResult] = await Promise.allSettled([paymentSettings(), runtimePixConfig()]);
  const portal = portalResult.status === 'fulfilled' ? portalResult.value : null;
  const legacy = legacyResult.status === 'fulfilled' ? legacyResult.value : null;
  const origin = safePublicOrigin(env.publicBaseUrl);
  res.json({
    partnerPortal: portal,
    partnerPortalError: portalResult.status === 'rejected' ? {
      code: portalResult.reason?.code || 'PAYMENT_SETTINGS_UNAVAILABLE',
      message: 'Não foi possível consultar os gateways do Painel do Parceiro. Verifique as migrações e os logs do backend.',
    } : null,
    legacyPix: legacy ? { provider: legacy.provider || null, enabled: Boolean(legacy.provider),
      tokenConfigured: Boolean(legacy.accessToken), webhookSecretConfigured: Boolean(legacy.webhookSecret) } : null,
    legacyPixError: legacyResult.status === 'rejected' ? {
      code: legacyResult.reason?.code || 'LEGACY_PIX_UNAVAILABLE',
      message: 'Não foi possível consultar a configuração Pix legada. Verifique os logs do backend.',
    } : null,
    publicBaseUrl: origin,
    publicHttps: Boolean(origin?.startsWith('https://')),
    webhooks: webhookCatalog(env.publicBaseUrl),
    webhookDeliveryMonitoring: false,
    policy: 'Somente o gateway do Painel do Parceiro pode ser trocado nesta tela. Cobranças Pix legadas e recebimentos das revendas usam configurações próprias; pedidos existentes mantêm o provedor original.',
  });
});
export default router;

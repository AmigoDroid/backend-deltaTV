import { WhiteLabelApp, WhiteLabelAppAppearance, WhiteLabelAppServer } from '../../db/models/index.js';
import { AppError, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { env } from '../../config/env.js';
import { defaultAppearance } from './appearance.presets.js';
import { buildZip } from './roku-zip.js';
import { TEMPLATE, ROKU_EDITIONS, filesIn, individualize } from './roku-builder.core.js';
import { loadRokuAssets } from './roku-assets.js';

export async function generateRokuBuild(appId, partnerId, edition, actor, buildVersion = 1) {
  if(!ROKU_EDITIONS.includes(edition)) throw new AppError(422,'ROKU_EDITION_INVALID','Modalidade inválida.');
  const app=await WhiteLabelApp.findOne({where:{id:appId,...(partnerId?{partnerId}:{})}});
  if(!app) throw notFound('Aplicativo');
  if(partnerId && !app.appearanceEnabled) throw new AppError(403,'APPEARANCE_DISABLED','Solicite ao Superadmin a liberação do Estúdio Visual.');
  if(app.status==='archived') throw new AppError(409,'APP_ARCHIVED','Não é possível exportar aplicativo arquivado.');
  if(await WhiteLabelAppServer.count({where:{appId,status:'active'}})===0)
    throw new AppError(409,'NO_ACTIVE_SERVER','Cadastre ao menos uma URL Xtream ativa antes de gerar o aplicativo.');
  const appearance=await WhiteLabelAppAppearance.findOne({where:{appId}});
  if(edition==='dedicated' && !appearance?.publishedConfig)
    throw new AppError(409,'APPEARANCE_NOT_PUBLISHED','Publique o visual antes de gerar a edição própria.');
  // Affordable edition uses published theme at runtime, with a simple neutral fallback.
  // Dedicated edition includes a snapshot so it renders branded UI even offline.
  const visual=edition==='dedicated' ? appearance.publishedConfig : defaultAppearance(app.name,app.logoUrl);
  const sanitized = Object.fromEntries(Object.entries(visual).filter(([k])=>['screens','template','brandName','tagline','heroTitle','logoUrl','heroUrl','primaryColor','backgroundColor','panelColor','textColor'].includes(k)));
  if(edition==='economy') sanitized.heroUrl='';
  const origin = new URL(env.publicBaseUrl).origin;
  if(process.env.NODE_ENV==='production' && !origin.startsWith('https://')) throw new AppError(500,'HTTPS_REQUIRED','Configure PUBLIC_BASE_URL com HTTPS.');
  const files=individualize(await filesIn(TEMPLATE),{appKey:app.appKey,appName:edition==='dedicated'?(sanitized.brandName || app.name):app.name,
    appearance:sanitized,edition,origin,buildVersion,assets:edition==='dedicated'?await loadRokuAssets(app.id):{}});
  const buffer=buildZip(files);
  await audit({actor,action:'white-label.roku.export',entityType:'white_label_app',entityId:app.id,
    metadata:{edition,buildVersion,appKey:app.appKey,appearanceVersion:appearance?.publishedVersion??0,bytes:buffer.length}});
  return {filename:`roku-${app.appKey}-${edition}-build${String(buildVersion).padStart(5,'0')}-sideload.zip`,buffer};
}

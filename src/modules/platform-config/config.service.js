import {getPlatformSettings,savePlatformSection} from '../settings/platform-settings.service.js';
import {paymentSettings,setDefaultGateway} from '../partner-portal-sales/checkout.service.js';
import {costForecast,updateCosts} from '../partner-portal-sales/sales.service.js';
import {runtimePixConfig} from '../pix/providers/index.js';
import {webhookCatalog,safePublicOrigin} from '../payment-gateways/overview.js';
import {env} from '../../config/env.js';

const value=(result)=>result.status==='fulfilled'?result.value:null;
const err=(result)=>result.status==='rejected' ? {
 code:result.reason?.code||'SECTION_UNAVAILABLE',
 message:'Não foi possível consultar esta seção. Confira migrações, configurações e os logs da API.'}:null;

/** Admin configuration facade. Uses the existing services, without copying
 * settings into another table or changing legacy checkout logic. */
export async function getGlobalConfig(){
 const [platform,payment,costs,legacy]=await Promise.allSettled([
  getPlatformSettings(),paymentSettings(),costForecast(),runtimePixConfig()]);
 const url=safePublicOrigin(env.publicBaseUrl);
 const pix=value(legacy);
 return {platform:value(platform),payment:value(payment),costs:value(costs),
  legacyPix:pix?{provider:pix.provider||null,configured:!!pix.accessToken,webhookSecretConfigured:!!pix.webhookSecret}:null,
  errors:{platform:err(platform),payment:err(payment),costs:err(costs),legacyPix:err(legacy)},
  webhooks:webhookCatalog(env.publicBaseUrl),publicHttps:!!url?.startsWith('https://'),
  monitoringAvailable:false};
}
export async function updateGlobalSection(section,input,actor){
 if(section==='trial'||section==='web')return savePlatformSection(section,input,actor);
 if(section==='payments')return setDefaultGateway(input.defaultGateway,actor);
 if(section==='costs')return updateCosts(input,actor);
 throw new RangeError('Seção global desconhecida');
}

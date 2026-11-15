import {env} from '../../../config/env.js';
import {AppError} from '../../../shared/errors.js';
import {decryptSecret,sha256} from '../../../shared/crypto.js';
import {readControls} from '../../superadmin/settings.js';
import {createMercadoPago} from './mercadopago.js';import {createMock} from './mock.js';
let instance=null,signature='';
export async function runtimePixConfig(){
 const controls=await readControls(),entry=controls.integrations.find(x=>x.name==='mercadopago');
 if(entry){if(!entry.enabled)return {provider:'',accessToken:'',webhookSecret:''};let config;try{config=JSON.parse(decryptSecret(entry.secretEnc))}catch{throw new AppError(503,'PIX_CONFIG_INVALID','Configuração de Pix inválida. Revise a integração no superadmin.')}return {provider:'mercadopago',...config};}
 return {provider:env.pixProvider,accessToken:env.mpAccessToken,webhookSecret:env.mpWebhookSecret};
}
export const pixEnabled=async()=>Boolean((await runtimePixConfig()).provider);
export async function getProvider(){const config=await runtimePixConfig();if(!config.provider)throw new AppError(503,'PIX_DISABLED','Pagamento por Pix não está habilitado. Fale com a plataforma.');const next=sha256(JSON.stringify(config));if(!instance||signature!==next){instance=config.provider==='mock'?createMock():createMercadoPago({accessToken:config.accessToken,webhookSecret:config.webhookSecret});signature=next}return instance;}

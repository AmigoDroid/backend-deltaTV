import { sequelize, ClientApp } from '../src/db/models/index.js';

const identifier = process.env.APP_ID || 'dreamplayer';
const name = process.env.APP_NAME || 'Dream Player';
const logoUrl = process.env.APP_LOGO_URL || (identifier === 'dreamplayer' ? 'https://parceiro.deltatv.com.br/dreamplayer.png' : null);
const theme = identifier === 'dreamplayer'
  ? { background: '#02030A', panel: '#070D24', primary: '#1F4BFF', text: '#F2F6FF', muted: '#A9BCD6' }
  : null;
if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(identifier) || ['roku','delta-tv-roku'].includes(identifier)) {
  console.error('APP_ID inválido ou reservado. Nenhuma alteração realizada.');
  process.exitCode = 1;
} else {
  try {
    const [app, created] = await ClientApp.findOrCreate({ where: { identifier }, defaults: { identifier, name, platform: 'roku', status: 'active', logoUrl, theme } });
    if (!created && (!app.logoUrl || !app.theme)) {
      await app.update({ ...(app.logoUrl ? {} : { logoUrl }), ...(app.theme ? {} : { theme }) });
    }
    console.log(`${created ? 'Criado' : 'Já existente'}: ${app.identifier} (${app.id}). Vincule pelo Admin ou com código de uso único.`);
  } catch (error) {
    console.error('Falha ao cadastrar app:', error.message);
    process.exitCode = 1;
  }
}
await sequelize.close();

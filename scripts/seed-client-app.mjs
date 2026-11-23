import { sequelize, ClientApp } from '../src/db/models/index.js';

const identifier = process.env.APP_ID || 'dreamplayer';
const name = process.env.APP_NAME || 'Dream Player';
if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(identifier) || ['roku','delta-tv-roku'].includes(identifier)) {
  console.error('APP_ID inválido ou reservado. Nenhuma alteração realizada.');
  process.exitCode = 1;
} else {
  try {
    const [app, created] = await ClientApp.findOrCreate({ where: { identifier }, defaults: { identifier, name, platform: 'roku', status: 'active' } });
    console.log(`${created ? 'Criado' : 'Já existente'}: ${app.identifier} (${app.id}). Vincule pelo Admin ou com código de uso único.`);
  } catch (error) {
    console.error('Falha ao cadastrar app:', error.message);
    process.exitCode = 1;
  }
}
await sequelize.close();

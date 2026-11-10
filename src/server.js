import { env } from "./config/env.js";
import { proxyConfigurationWarnings } from "./shared/proxy-config.js";
import { sequelize } from "./db/sequelize.js";
import { verifyRequiredSchema } from "./db/schema-preflight.js";
import { createApp } from "./app.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startPresence, stopPresence, countOnline } from "./modules/devices/presence.js";
import { attachRealtime, broadcastDevicePresence } from "./realtime/socket.js";
import dotenv from "dotenv";
import { startAudit, stopAudit } from "./modules/connection-audit/service.js";
import { startProviderMonitor,stopProviderMonitor } from "./modules/provider-monitor/monitor.service.js";
dotenv.config();

await sequelize.authenticate();
await verifyRequiredSchema(sequelize);
const app = createApp();
const server = app.listen(env.port, env.bindHost, () => {
  console.log(`API de licenciamento em ${env.bindHost}:${env.port} (${env.nodeEnv}); trust proxy=${String(env.trustProxy)}`);
  for (const warning of proxyConfigurationWarnings(env)) console.warn(`[proxy] ${warning}`);
});
const stopRealtime = attachRealtime(server);
// Envio de APKs grandes (painel admin → Downloads): o padrão do Node (5 min para receber a requisição inteira) corta
// uploads em conexões lentas. Configurável: DOWNLOAD_UPLOAD_TIMEOUT_MIN (padrão 30).
server.requestTimeout = (Number.parseInt(process.env.DOWNLOAD_UPLOAD_TIMEOUT_MIN ?? "", 10) || 30) * 60_000;
// O flush da presença roda em TODA instância (não depende do scheduler): cada processo grava os sinais que recebeu.
startPresence();
startAudit();
// Publica somente mudanças de contagem. O prazo de expiração dos heartbeats também
// é observado, mesmo quando nenhum aparelho faz nova requisição.
let previousOnline = null;
let checkingOnline = false;
async function publishOnlineIfChanged() {
  if (checkingOnline) return;
  checkingOnline = true;
  try {
    const count = await countOnline();
    if (count !== previousOnline) {
      previousOnline = count;
      broadcastDevicePresence(count, env.presenceWindowSeconds);
    }
  } catch (err) { console.warn("[device-presence-ws]", err.message); }
  finally { checkingOnline = false; }
}
void publishOnlineIfChanged();
const devicePresenceTimer = setInterval(() => { void publishOnlineIfChanged(); }, 10000);
devicePresenceTimer.unref();
if (env.enableScheduler) { startScheduler(); startProviderMonitor(); }

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(devicePresenceTimer);
    stopProviderMonitor();
    stopRealtime();
    server.close(async () => {
      await stopAudit(); // descarrega a fila de auditoria antes de fechar o PostgreSQL
      await stopPresence(); // grava os últimos sinais antes de fechar o banco
      await sequelize.close();
      process.exit(0);
    });
  });
}

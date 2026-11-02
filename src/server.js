import { env } from "./config/env.js";
import { sequelize } from "./db/sequelize.js";
import { createApp } from "./app.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startPresence, stopPresence, countOnline } from "./modules/devices/presence.js";
import { attachRealtime, broadcastDevicePresence } from "./realtime/socket.js";
import dotenv from "dotenv";
dotenv.config();

await sequelize.authenticate();
const app = createApp();
const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(
    `API de licenciamento em http://localhost:${env.port} (${env.nodeEnv})`,
  );
});
const stopRealtime = attachRealtime(server);
// Envio de APKs grandes (painel admin → Downloads): o padrão do Node (5 min para receber a requisição inteira) corta
// uploads em conexões lentas. Configurável: DOWNLOAD_UPLOAD_TIMEOUT_MIN (padrão 30).
server.requestTimeout = (Number.parseInt(process.env.DOWNLOAD_UPLOAD_TIMEOUT_MIN ?? "", 10) || 30) * 60_000;
// O flush da presença roda em TODA instância (não depende do scheduler): cada processo grava os sinais que recebeu.
startPresence();
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
if (env.enableScheduler) startScheduler();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(devicePresenceTimer);
    stopRealtime();
    server.close(async () => {
      await stopPresence(); // grava os últimos sinais antes de fechar o banco
      await sequelize.close();
      process.exit(0);
    });
  });
}

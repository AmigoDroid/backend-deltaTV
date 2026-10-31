import { env } from "./config/env.js";
import { sequelize } from "./db/sequelize.js";
import { createApp } from "./app.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startPresence, stopPresence } from "./modules/devices/presence.js";
import dotenv from "dotenv";
dotenv.config();

await sequelize.authenticate();
const app = createApp();
const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(
    `API de licenciamento em http://localhost:${env.port} (${env.nodeEnv})`,
  );
});
// Envio de APKs grandes (painel admin → Downloads): o padrão do Node (5 min para receber a requisição inteira) corta
// uploads em conexões lentas. Configurável: DOWNLOAD_UPLOAD_TIMEOUT_MIN (padrão 30).
server.requestTimeout = (Number.parseInt(process.env.DOWNLOAD_UPLOAD_TIMEOUT_MIN ?? "", 10) || 30) * 60_000;
// O flush da presença roda em TODA instância (não depende do scheduler): cada processo grava os sinais que recebeu.
startPresence();
if (env.enableScheduler) startScheduler();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await stopPresence(); // grava os últimos sinais antes de fechar o banco
      await sequelize.close();
      process.exit(0);
    });
  });
}

import { env } from "./config/env.js";
import { sequelize } from "./db/sequelize.js";
import { createApp } from "./app.js";
import { startScheduler } from "./jobs/scheduler.js";
import dotenv from "dotenv";
dotenv.config();

await sequelize.authenticate();
const app = createApp();
const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(
    `API de licenciamento em http://localhost:${env.port} (${env.nodeEnv})`,
  );
});
if (env.enableScheduler) startScheduler();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await sequelize.close();
      process.exit(0);
    });
  });
}

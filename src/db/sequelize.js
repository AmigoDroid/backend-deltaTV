import { Sequelize } from "sequelize";
import { env } from "../config/env.js";

export const sequelize = new Sequelize(env.databaseUrl, {
  dialect: "postgres",
  logging: false,
  define: { underscored: true, timestamps: true },
  // Não abrir dezenas de conexões por processo num host de 2 vCPU / 2 GB.
  // PM2 clusters multiplicam esse limite; manter DB_POOL_MAX * instâncias abaixo de max_connections.
  pool: { max: Math.min(20, Math.max(2, Number.parseInt(process.env.DB_POOL_MAX || '8', 10) || 8)),
    min: 0, idle: 10000, acquire: 20000 },
  dialectOptions: env.dbSsl ? { ssl: { require: true, rejectUnauthorized: env.dbSslStrict } } : {},
});
// IMPORTANTE: nunca chamar sequelize.sync() — a estrutura evolui apenas por migrations.

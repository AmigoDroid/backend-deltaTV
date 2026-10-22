import { Sequelize } from "sequelize";
import { env } from "../config/env.js";

export const sequelize = new Sequelize(env.databaseUrl, {
  dialect: "postgres",
  logging: false,
  define: { underscored: true, timestamps: true },
  pool: { max: 10, min: 0, idle: 10000 },
  dialectOptions: env.dbSsl ? { ssl: { require: true, rejectUnauthorized: env.dbSslStrict } } : {},
});
// IMPORTANTE: nunca chamar sequelize.sync() — a estrutura evolui apenas por migrations.

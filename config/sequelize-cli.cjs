// Configuração usada apenas pelo sequelize-cli (migrations/seeders).
// Sem fallback: nunca existe um banco "padrão". Migrations (inclusive db:migrate:undo:all) só rodam contra o
// banco informado explicitamente em DATABASE_URL, para ninguém alterar um banco remoto por esquecimento.
require("dotenv").config();
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "DATABASE_URL é obrigatória (ex.: postgres://usuario:senha@localhost:5432/iptv_licensing). Não há valor padrão.",
  );
const ssl =
  process.env.DB_SSL === "true"
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: process.env.DB_SSL_STRICT !== "false",
        },
      }
    : {};
const base = { url, dialect: "postgres", dialectOptions: ssl, logging: false };
module.exports = { development: base, test: base, production: base };

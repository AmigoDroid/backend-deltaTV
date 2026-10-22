"use strict";
// Cria o primeiro superadmin a partir de ADMIN_EMAIL / ADMIN_PASSWORD (nunca fixados no código).
// Falha explicitamente (em vez de "passar em silêncio") quando as variáveis estão ausentes ou inválidas.
module.exports = {
  async up(queryInterface) {
    const email = (process.env.ADMIN_EMAIL || "").trim();
    const password = process.env.ADMIN_PASSWORD || "";
    if (!email || !password) {
      throw new Error(
        "ADMIN_EMAIL e ADMIN_PASSWORD estão vazios. Preencha-os no .env (ou passe na linha de comando) e rode de novo.",
      );
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("ADMIN_EMAIL não é um e-mail válido.");
    if (password.length < 12) throw new Error("ADMIN_PASSWORD deve ter ao menos 12 caracteres.");

    const { hashPassword } = await import("../../shared/crypto.js");
    const hash = await hashPassword(password);
    const [, meta] = await queryInterface.sequelize.query(
      `INSERT INTO admin_users (name, email, password_hash, role)
       SELECT 'Administrador', :email, :hash, 'superadmin'
       WHERE NOT EXISTS (SELECT 1 FROM admin_users WHERE lower(email) = lower(:email))`,
      { replacements: { email, hash } },
    );
    const created = (meta?.rowCount ?? 0) > 0;
    console.log(created ? `Superadmin criado: ${email}` : `Superadmin já existe (${email}); nada alterado.`);
  },
  async down(queryInterface) {
    if (process.env.ADMIN_EMAIL) {
      await queryInterface.sequelize.query(
        `DELETE FROM admin_users WHERE lower(email) = lower(:email) AND role = 'superadmin'`,
        { replacements: { email: process.env.ADMIN_EMAIL } },
      );
    }
  },
};

"use strict";
/*
 * Clientes do revendedor: agenda privada por MAC (nome, telefone, endereço, valor cobrado e vencimento).
 *
 *  - Ficha PRIVADA do revendedor (partner_id): outro revendedor nunca a enxerga, nem com o mesmo MAC.
 *  - O MAC não precisa existir em `devices`: dá para cadastrar à mão antes de a TV ativar (por isso não há FK).
 *  - price_cents/due_date são o combinado do revendedor COM o cliente dele; não têm relação com a licença nem com as
 *    faturas/Pix da plataforma. Excluir a ficha NÃO mexe em dispositivo, ativação nem licença.
 */
const UP = `
CREATE TABLE reseller_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  mac char(17) NOT NULL CHECK (mac ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'),
  name varchar(160) NOT NULL CHECK (length(btrim(name)) >= 2),
  phone varchar(30),
  address varchar(300),
  price_cents int CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 100000000),
  due_date date,
  notes varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_reseller_clients_partner_mac ON reseller_clients (partner_id, mac);
CREATE INDEX ix_reseller_clients_due ON reseller_clients (partner_id, due_date);
`;

const DOWN = `DROP TABLE IF EXISTS reseller_clients;`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};

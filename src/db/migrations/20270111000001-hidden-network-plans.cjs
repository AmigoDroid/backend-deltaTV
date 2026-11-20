"use strict";
// A visibilidade comercial não altera os vínculos existentes.
module.exports = {
  async up(q, S) {
    await q.addColumn('service_plan_catalogs', 'hidden_from_network',
      {type:S.BOOLEAN,allowNull:false,defaultValue:false});
  },
  async down(q) {
    await q.removeColumn('service_plan_catalogs','hidden_from_network');
  },
};

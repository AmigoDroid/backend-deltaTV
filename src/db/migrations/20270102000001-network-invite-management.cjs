"use strict";
module.exports={
 async up(q,S){await q.addColumn('admin_network_invitations','deleted_at',{type:S.DATE,allowNull:true}); await q.addIndex('admin_network_invitations',['owner_admin_id','deleted_at'],{name:'idx_admin_invites_visible'});},
 async down(q){await q.removeIndex('admin_network_invitations','idx_admin_invites_visible');await q.removeColumn('admin_network_invitations','deleted_at');}
};

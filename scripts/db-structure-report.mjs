#!/usr/bin/env node
/** Diagnóstico agregado sem CPF, IP, MAC, credenciais ou nome de cliente. */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/db/sequelize.js';
const queries={
 clients:`SELECT count(*)::int AS total, count(device_id)::int AS linked,
          count(*) FILTER (WHERE device_id IS NULL)::int AS unlinked FROM reseller_clients`,
 identityIssues:`SELECT reason, count(*)::int AS records FROM v_delta_client_link_issues GROUP BY reason ORDER BY records DESC`,
 devices:`SELECT count(*)::int AS total, count(mac)::int AS mac_identified FROM devices`,
 activations:`SELECT status, count(*)::int AS count FROM activations GROUP BY status ORDER BY count DESC`,
 providers:`SELECT COALESCE(probe_state,'unknown') AS state, count(*)::int AS count FROM v_delta_provider_operations GROUP BY 1`,
 expiredSessions:`SELECT
   (SELECT count(*) FROM auth_sessions WHERE expires_at < now()-interval '30 days')::int AS admin,
   (SELECT count(*) FROM device_sessions WHERE expires_at < now()-interval '30 days')::int AS client,
   (SELECT count(*) FROM device_scoped_sessions WHERE expires_at < now()-interval '30 days')::int AS scoped`,
};
try { for(const [label,sql] of Object.entries(queries)){
  const rows=await sequelize.query(sql,{type:QueryTypes.SELECT});
  console.log(label,JSON.stringify(rows));
}} finally {await sequelize.close();}

#!/usr/bin/env node
/** Vinculação idempotente. Padrão: somente leitura. --apply exige backup confirmado.
 * O comando nunca apaga clientes, MACs, ativações, credenciais ou licenças.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/db/sequelize.js';
const apply = process.argv.includes('--apply');
if (apply && !process.argv.includes('--backup-confirmed')) {
  console.error('Para gravar vínculos: --apply --backup-confirmed, após backup restaurável.');
  process.exit(2);
}
try {
  const [counts] = await sequelize.query(`SELECT
    (SELECT count(*) FROM reseller_clients WHERE device_id IS NULL)::integer AS unlinked,
    (SELECT count(*) FROM v_delta_client_link_issues WHERE reason='identity_mismatch')::integer AS mismatch,
    (SELECT count(*) FROM v_delta_client_link_issues WHERE reason='requires_reconciliation')::integer AS pending`,
    { type:QueryTypes.SELECT });
  console.log('Diagnóstico agregado (sem informações de clientes):', counts);
  if (apply) {
    const [_, metadata] = await sequelize.query(`WITH candidates AS (
        SELECT c.id, MIN(a.device_id::text)::uuid AS device_id
        FROM reseller_clients c
        JOIN activations a ON a.partner_id=c.partner_id AND a.mac=c.mac AND a.status <> 'revoked'
        JOIN devices d ON d.id=a.device_id AND d.mac=c.mac
        WHERE c.device_id IS NULL
        GROUP BY c.id HAVING count(DISTINCT a.device_id)=1
        LIMIT 500
      ) UPDATE reseller_clients c SET device_id=x.device_id
        FROM candidates x WHERE c.id=x.id AND c.device_id IS NULL`,{ type:QueryTypes.RAW });
    console.log('Lote de vínculos aplicado (máximo 500). Execute novamente para outro lote.');
  } else console.log('Nenhuma alteração realizada. Para executar: --apply --backup-confirmed');
} finally { await sequelize.close(); }

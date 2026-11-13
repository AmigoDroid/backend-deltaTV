#!/usr/bin/env node
/** Limpeza exclusivamente de tokens expirados há >30 dias. Sem PII nos logs.
 * Segurança: dry-run default; --apply exige --backup-confirmed; 500 linhas por tabela/execução.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/db/sequelize.js';
const tables = ['auth_sessions','device_sessions','device_scoped_sessions']; // identificadores fixos, nunca vindos do usuário
const retentionDays=30;
const limit=500;
const apply=process.argv.includes('--apply');
if (apply && !process.argv.includes('--backup-confirmed')) {
  console.error('Limpeza recusada: passe --backup-confirmed somente após backup testado.');
  process.exit(2);
}
try {
  for (const table of tables) {
    const [summary]=await sequelize.query(`SELECT count(*)::integer AS expired FROM ${table}
      WHERE expires_at < now()-interval '30 days'`,{type:QueryTypes.SELECT});
    console.log(`${table}: ${summary.expired} sessões expiradas há mais de ${retentionDays} dias`);
    if (apply) {
      // Uma operação curta sem transação longa, limitando WAL e locks.
      await sequelize.query(`DELETE FROM ${table} WHERE id IN (
        SELECT id FROM ${table} WHERE expires_at < now()-interval '30 days'
        ORDER BY expires_at ASC LIMIT :limit FOR UPDATE SKIP LOCKED
      )`,{replacements:{limit},type:QueryTypes.RAW});
      console.log(`${table}: processamento limitado a ${limit} registros nesta execução`);
    }
  }
  if (!apply) console.log('DRY-RUN: nenhum dado removido. Para aplicar: --apply --backup-confirmed');
} finally { await sequelize.close(); }

import { AppError } from '../../shared/errors.js';

/** Não retornar 500 genérico quando as migrações da telemetria não foram aplicadas.
 * O diagnóstico de PostgreSQL fica somente nos logs; SQL e parâmetros não chegam ao cliente.
 */
export function classifyUsageError(error) {
  if (error instanceof AppError) return error;
  const pg = error?.parent ?? error?.original ?? error?.cause ?? error;
  const pgCode = pg?.code;
  let result;
  if (pgCode === '42P01' || pgCode === '42703') {
    result = new AppError(503, 'PORTAL_USAGE_MIGRATION_REQUIRED',
      'As tabelas ou colunas do monitoramento comercial não estão atualizadas. Faça backup, execute npm run db:migrate e confira o diagnóstico no Superadmin.');
  } else if (['08000', '08001', '08003', '08006', '57P01', '57P02', '57P03', '53300'].includes(pgCode)) {
    result = new AppError(503, 'PORTAL_USAGE_DATABASE_UNAVAILABLE',
      'O banco de dados não está disponível para os relatórios de consumo. Verifique a conexão e o PostgreSQL.');
  }
  if (!result) return error;
  // Apenas códigos técnicos, sem SQL, tokens ou valores de parâmetros.
  result.parent = {
    code: pgCode,
    ...(typeof pg.table === 'string' ? { table: pg.table } : {}),
    ...(typeof pg.column === 'string' ? { column: pg.column } : {}),
  };
  return result;
}

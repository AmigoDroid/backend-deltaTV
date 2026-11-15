import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../../src/shared/errors.js';
import {classifyUsageError} from '../../src/modules/partner-portal-usage/usage-errors.js';
import {USAGE_REQUIRED_COLUMNS, USAGE_MIGRATIONS, summarizeUsageSchema} from '../../src/modules/partner-portal-usage/usage-schema.js';

const allColumns = Object.entries(USAGE_REQUIRED_COLUMNS).flatMap(([table_name, cols])=>
  cols.map(column_name=>({table_name,column_name})));

test('diagnóstico confirma esquema completo e migrations aplicadas',()=>{
 const s=summarizeUsageSchema(allColumns,USAGE_MIGRATIONS,{settingsRows:{partner_portal_cost_settings:true,partner_portal_usage_alert_settings:true}});
 assert.equal(s.ready,true);assert.deepEqual(s.missingTables,[]);assert.deepEqual(s.missingColumns,[]);
});
test('detecta ausência da migração de telemetria mesmo com tabelas presentes',()=>{
 const s=summarizeUsageSchema(allColumns,[USAGE_MIGRATIONS[0]]);
 assert.equal(s.ready,false);assert.deepEqual(s.pendingMigrations,[USAGE_MIGRATIONS[1]]);
});
test('detecta tabela ausente para os três endpoints em vez de relatar 0 GB',()=>{
 const s=summarizeUsageSchema(allColumns.filter(r=>r.table_name!=='partner_portal_usage_hourly'),USAGE_MIGRATIONS);
 assert.deepEqual(s.missingTables,['partner_portal_usage_hourly']);assert.equal(s.ready,false);
});
test('detecta coluna ausente e linha de configuração não inserida',()=>{
 const s=summarizeUsageSchema(allColumns.filter(r=>r.column_name!=='bytes_out'),USAGE_MIGRATIONS,{settingsRows:{partner_portal_cost_settings:false}});
 assert.ok(s.missingColumns.includes('partner_portal_usage_hourly.bytes_out'));
 assert.deepEqual(s.missingSettings,['partner_portal_cost_settings']);
});
test('não declara prontidão com controle de migrações indisponível',()=>{
 const s=summarizeUsageSchema(allColumns,[],{migrationsKnown:false});
 assert.equal(s.ready,false);assert.equal(s.status,'migration_status_unknown');
});
test('trata Sequelize 42P01 como 503 com código específico, sem vazar SQL',()=>{
 const e=classifyUsageError({name:'SequelizeDatabaseError',sql:'SELECT senha FROM users',parent:{code:'42P01',table:'partner_portal_usage_hourly'}});
 assert.equal(e.status,503);assert.equal(e.code,'PORTAL_USAGE_MIGRATION_REQUIRED');
 assert.ok(!JSON.stringify(e).includes('senha'));assert.equal(e.parent.code,'42P01');
});
test('trata coluna ausente como migração incompleta',()=>{
 const e=classifyUsageError({original:{code:'42703',column:'bytes_out'}});
 assert.equal(e.status,503);assert.equal(e.code,'PORTAL_USAGE_MIGRATION_REQUIRED');
});
test('trata indisponibilidade do Postgres como 503 mas não inventa diagnóstico de migração',()=>{
 const e=classifyUsageError({parent:{code:'08006'}});
 assert.equal(e.status,503);assert.equal(e.code,'PORTAL_USAGE_DATABASE_UNAVAILABLE');
});
test('não disfarça SQL inválido como migração ausente',()=>{
 const e={parent:{code:'42601'}};
 assert.equal(classifyUsageError(e),e);
});
test('preserva AppError de validação e autorização',()=>{
 const e=new AppError(403,'SUPERADMIN_ONLY','Negado');
 assert.equal(classifyUsageError(e),e);
});

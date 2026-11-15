import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { errorHandler } from '../../src/shared/errors.js';

const clientAdmin = new URL('../../src/modules/clients/client.admin.service.js', import.meta.url);
const clientService = new URL('../../src/modules/clients/client.service.js', import.meta.url);

test('admin não importa quota removida do serviço', () => {
  const admin = readFileSync(clientAdmin, 'utf8');
  const service = readFileSync(clientService, 'utf8');
  assert.doesNotMatch(admin, /\bMAX_CLIENTS_PER_PARTNER\b/);
  assert.match(admin, /import \{ createClient, deleteClient/);
  assert.match(service, /export (?:async )?function createClient\b/);
});

test('erro PostgreSQL mostra rota parametrizada e posição sem expor SQL e credenciais', () => {
  const calls=[];
  const original = console.error;
  console.error = (...args) => calls.push(args.join(' '));
  const error = new Error('syntax error at or near SECRET');
  error.name='SequelizeDatabaseError';
  error.sql="SELECT 'TOKEN-SIGILOSO'";
  error.parent={ code:'42601', position:'27' };
  const request={id:'req123', method:'POST', route:{path:'/clients/:id'}, originalUrl:'/clients/SENHA-DE-TESTE?token=SEGREDO'};
  const response={ headersSent:false, status(n){this.statusCode=n;return this;}, json(v){this.body=v;return this;} };
  try { errorHandler(error,request,response,()=>{}); }
  finally { console.error = original; }
  assert.equal(response.statusCode,500);
  assert.equal(response.body.requestId,'req123');
  const line=calls.join('\n');
  assert.match(line,/pgCode=42601/);
  assert.match(line,/position=27/);
  assert.match(line,/POST \/clients\/:id/);
  assert.doesNotMatch(line,/TOKEN-SIGILOSO|SENHA-DE-TESTE|SEGREDO/);
});

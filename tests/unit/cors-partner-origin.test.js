import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const envExample = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
const expressApp = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const envConfig = readFileSync(new URL('../../src/config/env.js', import.meta.url), 'utf8');

test('A1: exemplo CORS inclui as quatro origens dos painéis locais', () => {
  const entry = envExample.match(/^CORS_ORIGINS=(.*)$/m)?.[1];
  assert.ok(entry, 'CORS_ORIGINS é obrigatória no arquivo de exemplo');
  const origins = entry.split(',').map(value => value.trim());
  assert.deepEqual(origins, [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
  ]);
});

test('A1: produção lê origens configuradas e Express exige igualdade exata', () => {
  assert.match(envConfig, /e\.CORS_ORIGINS\s*\|\|/);
  assert.match(expressApp, /env\.corsOrigins\.includes\(origin\)/);
});

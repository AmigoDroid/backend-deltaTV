import test from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../../src/shared/errors.js';

function sendIssue(issue) {
  const err = new Error('Mensagem automática em outro idioma');
  err.name = 'ZodError';
  err.issues = [issue];
  const req = { id: 'teste-ptbr', method: 'POST', originalUrl: '/partner/apps/claim' };
  const res = { headersSent: false, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  const previous = console.warn;
  console.warn = () => {};
  try { errorHandler(err, req, res, () => {}); }
  finally { console.warn = previous; }
  return res;
}

test('mensagem de tamanho mínimo usa português brasileiro e nome do campo legível', () => {
  const res = sendIssue({ code: 'too_small', path: ['claimCode'], minimum: 10, origin: 'string', message: 'Too small' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal(res.body.message, 'Código de vinculação: Informe pelo menos 10 caracteres.');
  assert.equal(res.body.details[0].path, 'claimCode');
  assert.doesNotMatch(res.body.details[0].message, /claimCode|Too small|Demasiado/i);
});

test('código de parceria inválido tem mensagem amigável', () => {
  const res = sendIssue({ code: 'invalid_format', path: ['partnerCodeId'], format: 'uuid', message: 'Invalid UUID' });
  assert.equal(res.body.message, 'Código da parceria: Selecione um identificador válido.');
});

test('senha não é exposta mesmo se a mensagem original incluir valor sensível', () => {
  const res = sendIssue({ code: 'too_big', path: ['password'], maximum: 128, origin: 'string', message: 'SECRET-DO-CLIENTE' });
  assert.equal(res.body.message, 'Senha: Informe no máximo 128 caracteres.');
  assert.doesNotMatch(JSON.stringify(res.body), /SECRET-DO-CLIENTE/);
});

test('outras validações não mostram nomes técnicos de campos', () => {
  const res = sendIssue({ code: 'invalid_type', path: ['unknownField'], input: undefined, message: 'Invalid input' });
  assert.equal(res.body.message, 'Campo informado: Este campo é obrigatório.');
});

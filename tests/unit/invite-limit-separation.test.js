import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('verificação, login e conclusão de convites utilizam instâncias independentes de limitador', () => {
  const security = src('../../src/middleware/security.js');
  assert.match(security, /export const inviteVerifyLimiter\s*=\s*limiter\(15 \* 60_000, 30\)/);
  assert.match(security, /export const inviteCompleteLimiter\s*=\s*limiter\(60 \* 60_000, 10\)/);
  assert.match(security, /export const loginLimiter\s*=\s*limiter\(15 \* 60_000, 10\)/);
  assert.match(security, /export const signupLimiter\s*=\s*limiter\(60 \* 60_000, 5\)/);
  const auth = src('../../src/modules/auth/auth.routes.js');
  const network = src('../../src/modules/distribution/network.routes.js');
  const adminNetwork = src('../../src/modules/admin-workspaces/network-invite-public.routes.js');
  assert.match(auth, /"\/partner-invite\/verify", inviteVerifyLimiter/);
  assert.match(auth, /"\/partner-invite\/complete", inviteCompleteLimiter/);
  assert.match(network, /post\("\/verify",inviteVerifyLimiter/);
  assert.match(adminNetwork, /post\('\/verify',inviteVerifyLimiter/);
  assert.match(adminNetwork, /post\('\/complete',inviteCompleteLimiter/);
  assert.doesNotMatch(auth, /"\/partner-invite\/verify", loginLimiter/);
  assert.doesNotMatch(network, /post\("\/verify",signupLimiter/);
});

test('cadastro sem convite mantém aprovação, cadastro por convite informa acesso imediato condicional sem revelar cadastro existente', () => {
  const auth = src('../../src/modules/auth/auth.routes.js');
  assert.match(auth, /SIGNUP_INVITED_OK/);
  assert.match(auth, /req\.valid\.body\.inviteToken\s*\?\s*SIGNUP_INVITED_OK\s*:\s*SIGNUP_OK/);
});

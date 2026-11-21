import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercita a função original com as dependências simuladas, sem conectar ao banco.
const file = readFileSync(new URL('../../src/middleware/authenticate.js', import.meta.url), 'utf8');
const start = file.indexOf('export async function resolveAdminClaims(payload) {');
const end = file.indexOf('export async function authenticate(', start);
assert.ok(start !== -1 && end > start, 'resolveAdminClaims precisa existir');
const source = file.slice(start, end).replace('export async function', 'async function');

function claimsFor(partner, role = 'partner') {
  const user = {
    id: 'user-1', name: 'Teste', email: 'teste@example.com',
    role, status: 'active', tokenVersion: 1, partnerId: 'partner-1',
    permissionRoleId: null, delegatedPermissions: [], networkLimits: {},
    deletedAt: null,
  };
  const mocks = {
    AdminUser: { findByPk: async () => user },
    AuthSession: { findOne: async () => ({ audience: 'content_partner', portalPartnerId: 'partner-1' }) },
    ImpersonationGrant: { findOne: async () => null },
    Partner: { findByPk: async () => partner },
    PermissionRole: { findByPk: async () => null },
    Op: { gt: Symbol('gt') },
    sessionContext: () => 'partner',
    roleForContext: () => 'partner',
    PORTAL_AUDIENCES: ['partner', 'content_partner'],
    findPortalAccount: async () => partner,
    isNetworkPortalAccessible: () => true,
    isNetworkRenewalOnlyPartner: p => Boolean(p.renewalOnly),
    effectivePartnerStatus: () => 'active',
    normalizeNetworkPermissions: () => [],
    normalizeNetworkLimits: () => ({}),
    PERMISSIONS: { partner: ['partner:dashboard:read'] },
    AppError: class AppError extends Error {},
  };
  const names = Object.keys(mocks);
  const fn = new Function(...names, `${source}; return resolveAdminClaims;`)(...Object.values(mocks));
  return fn({ sub: user.id, sid: 'session-1', tv: 1, ctx: 'partner' });
}

test('sessão de parceiro ativa é resolvida sem ReferenceError', async () => {
  const result = await claimsFor({ id: 'partner-1', kind: 'content', status: 'active', renewalOnly: false });
  assert.equal(result.user.role, 'partner');
  assert.equal(result.user.renewalOnly, false);
});

test('restrição de renovação do parceiro é preservada', async () => {
  const result = await claimsFor({ id: 'partner-1', kind: 'content', status: 'active', renewalOnly: true });
  assert.equal(result.user.renewalOnly, true);
});

test('admin com acesso ao portal de parceiro não perde o contexto', async () => {
  const result = await claimsFor({ id: 'partner-1', kind: 'content', status: 'active', renewalOnly: false }, 'admin');
  assert.equal(result.user.role, 'partner');
  assert.equal(result.user.portalAdmin, true);
  assert.equal(result.user.partnerId, 'partner-1');
});

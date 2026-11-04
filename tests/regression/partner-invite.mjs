// Run: NODE_ENV=test node --experimental-test-module-mocks --test tests/regression/partner-invite.mjs
// Simulates persistence; no production database or SMTP is used.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { sequelize, Partner, PartnerPreRegistration, AdminUser, AuditLog, ContentPartnerTerms } from '../../src/db/models/index.js';
import { hashInviteToken } from '../../src/modules/partners/partner-invite.policy.js';
const realtime = await import('../../src/realtime/socket.js');
const events = [];
mock.module('../../src/realtime/socket.js', { namedExports: { ...realtime, broadcastChange: event => events.push(event) } });
const { completePreRegistration, listPreRegistrations, finishPreRegistration } = await import('../../src/modules/partners/partner-invite.service.js');
const { listPartners, updatePartner } = await import('../../src/modules/partners/partner.service.js');
const { saveTerms } = await import('../../src/modules/content-commerce/commerce.service.js');
const { createApp } = await import('../../src/app.js');
const token = 'a'.repeat(43);
let partners, users, registration, failUser, extraInvites, termsRow;
const instance = data => ({ ...data, async update(values) { Object.assign(this, values); return this; }, toJSON() { const { toJSON, ...row } = this; return row; } });
function reset() {
  partners = []; users = []; failUser = false; extraInvites = []; termsRow = null; events.length = 0;
  registration = { id: 'invite-1', name: 'Responsável', email: 'parceiro@example.test', status: 'invited', configuredAt: null, tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + 60000) };
  registration.update = async data => Object.assign(registration, data);
}
mock.method(sequelize, 'transaction', async callback => {
  const before = { registration: { ...registration }, partners: [...partners], users: [...users] };
  try { return await callback({ LOCK: { UPDATE: 'UPDATE' } }); }
  catch (error) { registration = before.registration; partners = before.partners; users = before.users; throw error; }
});
mock.method(PartnerPreRegistration, 'findOne', async ({ where }) => registration.tokenHash === where.tokenHash ? registration : null);
const matches = (row, where) => Reflect.ownKeys(where).every(key => {
  if (key === Op.or) return where[key].some(condition => matches(row, condition));
  const condition = where[key];
  if (condition && typeof condition === 'object') {
    if (Op.ne in condition) return condition[Op.ne] === null ? row[key] != null : row[key] !== condition[Op.ne];
  }
  return condition === null ? row[key] == null : row[key] === condition;
});
const matchingInvites = where => [registration, ...extraInvites].filter(row => matches(row, where));
mock.method(PartnerPreRegistration, 'findAndCountAll', async ({ where, limit, offset }) => {
  const rows = matchingInvites(where); return { rows: rows.slice(offset, offset + limit), count: rows.length };
});
mock.method(PartnerPreRegistration, 'count', async ({ where }) => matchingInvites(where).length);
mock.method(PartnerPreRegistration, 'findByPk', async id => registration.id === id ? registration : null);
mock.method(PartnerPreRegistration, 'update', async (values, { where }) => {
  const rows = matchingInvites(where); for (const row of rows) Object.assign(row, values); return [rows.length];
});
mock.method(Partner, 'findByPk', async id => partners.find(row => row.id === id) || null);
mock.method(ContentPartnerTerms, 'findByPk', async () => termsRow);
mock.method(sequelize, 'query', async () => []);
mock.method(AdminUser, 'findOne', async () => null);
mock.method(Partner, 'findOne', async () => null);
mock.method(Partner, 'create', async data => { const row = instance({ ...data, id: '11111111-1111-4111-8111-111111111111' }); partners.push(row); return row; });
mock.method(AdminUser, 'create', async data => { if (failUser) throw Error('simulated user failure'); const row = { ...data, id: 'user-1' }; users.push(row); return row; });
mock.method(AuditLog, 'create', async data => data);
mock.method(Partner, 'findAndCountAll', async ({ where }) => {
  assert.deepEqual(where.kind[Op.in], ['content', 'both']);
  assert.equal(where.status[Op.ne], 'deleted');
  const rows = partners.filter(p => where.kind[Op.in].includes(p.kind) && p.status !== 'deleted' &&
    (!where[Op.or] || where[Op.or].some(condition => {
      const [field, pattern] = Object.entries(condition)[0];
      return String(p[field] || '').toLowerCase().includes(pattern[Op.iLike].slice(1, -1).toLowerCase());
    })));
  return { rows, count: rows.length };
});

test('concluded invite creates a content partner visible to the normal partner listing and preserves the configuration link', async () => {
  reset();
  const result = await completePreRegistration({ token, companyName: 'Empresa Convidada', password: 'test-password-1234' });
  assert.equal(result.ok, true);
  const list = await listPartners({ kind: 'content', page: 1, pageSize: 50 });
  assert.equal(list.meta.total, 1);
  assert.equal(list.data[0].name, 'Empresa Convidada');
  assert.equal(list.data[0].status, 'active');
  assert.equal(users[0].partnerId, list.data[0].id);
  assert.equal(users[0].role, 'partner');
  for (const q of ['Responsável', 'parceiro@example.test']) {
    const found = await listPartners({ kind: 'content', q, page: 1, pageSize: 50 });
    assert.equal(found.data[0]?.id, list.data[0].id);
  }
  const invitations = await listPreRegistrations();
  assert.equal(invitations.data[0].status, 'completed');
  assert.equal(invitations.data[0].completedPartnerId, list.data[0].id);
  await assert.rejects(completePreRegistration({ token, companyName: 'Duplicate', password: 'test-password-1234' }), error => error.code === 'INVALID_INVITE');
  assert.equal(partners.length, 1);
});

test('user creation failure rolls back the partner and does not mark the invite completed', async () => {
  reset(); failUser = true;
  await assert.rejects(completePreRegistration({ token, companyName: 'Empresa', password: 'test-password-1234' }), /simulated user failure/);
  assert.equal(partners.length, 0);
  assert.equal(registration.status, 'invited');
});

test('expired invite cannot create a partnership', async () => {
  reset(); registration.expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(completePreRegistration({ token, companyName: 'Empresa', password: 'test-password-1234' }), error => error.code === 'INVALID_INVITE');
  assert.equal(partners.length, 0);
});

test('public HTTP completion notifies administrators only after success; rejected reuse emits nothing', async () => {
  reset();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/auth/partner-invite/complete`;
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, companyName: 'Empresa HTTP', password: 'test-password-1234' }) };
    const response = await fetch(url, options);
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(events, [{ partnerId: null, topic: 'partners' }]);
    const rejected = await fetch(url, options);
    assert.equal(rejected.status, 400);
    assert.equal(events.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('saving partner conditions removes the completed invite from pending and preserves the partner and history', async () => {
  reset();
  await completePreRegistration({ token, companyName: 'Empresa', password: 'test-password-1234' });
  assert.equal((await listPreRegistrations()).summary.ready, 1);
  await updatePartner(partners[0].id, { name: 'Empresa configurada' }, { type: 'admin', id: 'admin-1' });
  assert.ok(registration.configuredAt);
  assert.equal((await listPreRegistrations()).data.length, 0);
  const history = await listPreRegistrations({ view: 'history' });
  assert.equal(history.data[0].completedPartnerId, partners[0].id);
  assert.equal(history.summary.history, 1);
  assert.equal((await listPartners({ kind: 'content', page: 1, pageSize: 50 })).data[0].name, 'Empresa configurada');
});

test('manual completion rejects an uncompleted invite and is idempotent after registration', async () => {
  reset();
  await assert.rejects(finishPreRegistration(registration.id, { type: 'admin' }), error => error.code === 'REGISTRATION_NOT_COMPLETED');
  await completePreRegistration({ token, companyName: 'Empresa', password: 'test-password-1234' });
  const first = await finishPreRegistration(registration.id, { type: 'admin' });
  const second = await finishPreRegistration(registration.id, { type: 'admin' });
  assert.equal(first.configuredAt, second.configuredAt);
  assert.equal((await listPreRegistrations()).meta.total, 0);
  assert.equal(partners.length, 1); assert.equal(users.length, 1);
});

test('pending and history queries paginate independently and cancelled invites do not fill pending', async () => {
  reset();
  extraInvites = Array.from({ length: 22 }, (_, i) => ({ id: `extra-${i}`, status: i < 20 ? 'invited' : 'cancelled', configuredAt: null }));
  const pending = await listPreRegistrations({ page: 2, pageSize: 8 });
  assert.equal(pending.data.length, 8);
  assert.equal(pending.meta.total, 21);
  assert.equal(pending.summary.history, 2);
  assert.ok(pending.data.every(row => row.status !== 'cancelled'));
  const history = await listPreRegistrations({ view: 'history', page: 1, pageSize: 8 });
  assert.equal(history.data.length, 2);
});


test('saving the commercial contract also finishes onboarding in the same transaction', async () => {
  reset();
  await completePreRegistration({ token, companyName: 'Empresa', password: 'test-password-1234' });
  termsRow = instance({ mode: 'legacy' });
  await saveTerms(partners[0].id, { mode: 'fixed_unlimited', fixedFeeCents: 5000 }, { type: 'admin' });
  assert.ok(registration.configuredAt);
  assert.equal(partners[0].monthlyFeeCents, 5000);
  assert.equal((await listPreRegistrations()).meta.total, 0);
  assert.equal((await listPreRegistrations({ view: 'history' })).meta.total, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the actual authenticate.js implementation with in-memory model doubles.
// No PostgreSQL, credentials, HTTP server or external packages required.
const source = readFileSync(new URL('../../src/middleware/authenticate.js', import.meta.url), 'utf8');
const withoutImports = source.replace(/^import\s+[^\n]+;\s*$/gm, '');
assert.doesNotMatch(withoutImports, /^\s*import\s/m, 'Harness must replace every import, not silently skip dependencies');

const doubles = `
const fixture = {user:null, partner:null, session:null, payload:null};
const PORTAL_AUDIENCES = ['partner', 'content_partner'];
const sessionContext = audience => PORTAL_AUDIENCES.includes(audience) ? 'partner' : 'admin';
const roleForContext = (role, context, linked) => context === 'partner' ? (linked ? 'partner' : null) : role;
const findPortalAccount = async () => fixture.partner;
const effectivePartnerStatus = partner => partner?.status === 'active' &&
  new Date(partner.endsAt).getTime() <= Date.now() ? 'expired' : partner?.status;
const isNetworkRenewalOnlyPartner = partner => Boolean(partner?.ownerAdminId &&
  partner?.status === 'active' && effectivePartnerStatus(partner) === 'expired');
const isNetworkPortalAccessible = (partner,audience) => Boolean(partner &&
  (effectivePartnerStatus(partner) === 'active' ||
    (audience === 'content_partner' && isNetworkRenewalOnlyPartner(partner))));
const governanceAudit = async (_req,_res,next) => next();
const adminHasNetworkPermission = () => false;
const normalizeNetworkPermissions = value => Array.isArray(value) ? value : [];
const normalizeNetworkLimits = value => value ?? {};
const Op = {gt: Symbol('gt'),lt: Symbol('lt'),or:Symbol('or')};
const AdminUser = {findByPk: async () => fixture.user,update:async()=>[1]};
const AuthSession = {findOne:async()=>fixture.session};
const Partner = {findByPk:async()=>fixture.partner};
const PermissionRole = {findByPk:async()=>null};
const ImpersonationGrant = {findOne:async()=>null};
const verifyJwt = () => fixture.payload;
class AppError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
export {fixture};
`;
const url = 'data:text/javascript;base64,' + Buffer.from(doubles + '\n' + withoutImports).toString('base64');
const subject = await import(url);

function setSession({role='partner', audience='content_partner', expires='2030-01-01', ownerAdminId=10} = {}) {
  subject.fixture.user = {
    id: 31, name: 'Teste', email:'teste@example.invalid', role, status:'active',
    partnerId:55, tokenVersion:9, deletedAt:null, permissionRoleId:null,
    delegatedPermissions:[], networkLimits:{},
  };
  subject.fixture.partner = {id:55,kind:'content',status:'active',endsAt:new Date(expires),ownerAdminId};
  subject.fixture.session = {id:8,audience,portalPartnerId:role==='admin'?55:null};
  subject.fixture.payload = {sub:31,tv:9,sid:8,ctx:audience==='admin'?'admin':'partner'};
}

test('parceiro ativo: autenticação resolve e não lança ReferenceError', async () => {
  setSession();
  const result = await subject.resolveAdminClaims(subject.fixture.payload);
  assert.equal(result.user.role,'partner');
  assert.equal(result.user.renewalOnly,false);
  assert.equal(result.user.partnerId,55);
});

test('parceiro expirado da rede: apenas modo renovação, sem ReferenceError', async () => {
  setSession({expires:'2020-01-01'});
  const result = await subject.resolveAdminClaims(subject.fixture.payload);
  assert.equal(result.user.renewalOnly,true);
  await assert.rejects(async()=>{
    await subject.authenticate({get:()=> 'Bearer dummy',originalUrl:'/api/v1/content-partner/overview',method:'GET'}, {},()=>{});
  },error => error?.code==='RENEWAL_ONLY' && error?.status===403);
});

test('conta expirada sem owner da rede não recebe exceção de renovação', async () => {
  setSession({expires:'2020-01-01',ownerAdminId:null});
  await assert.rejects(() => subject.resolveAdminClaims(subject.fixture.payload),
    error => error?.code==='INVALID_TOKEN' && error?.status===401);
});

test('sessão Admin não depende de partner e não ganha modo renovação', async () => {
  setSession({role:'admin',audience:'admin'});
  subject.fixture.partner = null;
  const result = await subject.resolveAdminClaims(subject.fixture.payload);
  assert.equal(result.user.role,'admin');
  assert.equal(result.user.renewalOnly,false);
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {adminHasNetworkPermission,normalizeNetworkPermissions,normalizeNetworkLimits,enforceLimit} from "../../src/modules/admin-workspaces/permissions.js";
import {canReceiveChange} from "../../src/realtime/routing-policy.js";
const file=path=>readFileSync(new URL(path,import.meta.url),"utf8");

test("Admin não herda direitos globais, wildcard ou gestão da VPS",()=>{
  const raw=["*","users:manage","vps:write","network:partners:read","network:partners:read","network:plans:write"];
  assert.deepEqual(normalizeNetworkPermissions(raw),["network:partners:read","network:plans:write"]);
  const admin={role:"admin",delegatedPermissions:["network:partners:read"]};
  assert.equal(adminHasNetworkPermission(admin,"network:partners:read"),true);
  assert.equal(adminHasNetworkPermission(admin,"network:partners:write"),false);
  assert.equal(adminHasNetworkPermission({...admin,delegatedPermissions:["*"]},"network:plans:write"),false);
  assert.equal(adminHasNetworkPermission({...admin,delegatedPermissions:["users:manage"]},"users:manage"),false);
  assert.equal(adminHasNetworkPermission({role:"superadmin"},"network:partners:write"),true);
});
test("quotas são definidas somente pela DeltaTV, 0 bloqueia e null libera",()=>{
  assert.deepEqual(normalizeNetworkLimits({maxPartners:3,maxDnsPerCode:null,extra:123}),{maxPartners:3,maxDnsPerCode:null});
  assert.throws(()=>normalizeNetworkLimits({maxPartners:-1}),/Limite inválido/);
  assert.throws(()=>enforceLimit(0,0,"LIMIT"),e=>e.status===409&&e.code==="LIMIT");
  assert.throws(()=>enforceLimit(10,10,"LIMIT"),e=>e.status===409);
  assert.doesNotThrow(()=>enforceLimit(null,999,"LIMIT"));
  assert.doesNotThrow(()=>enforceLimit(10,9,"LIMIT"));
});
test("WebSocket não envia presença nem mudanças globais a Admins de rede",()=>{
  assert.equal(canReceiveChange({role:"admin",id:"a"},null),false);
  assert.equal(canReceiveChange({role:"admin",id:"a"},"outro-partner"),false);
  assert.equal(canReceiveChange({role:"superadmin"},null),true);
  assert.equal(canReceiveChange({role:"partner",partnerId:"a"},"a"),true);
  assert.equal(canReceiveChange({role:"partner",partnerId:"a"},"b"),false);
  const ws=file("../../src/realtime/socket.js");
  assert.match(ws,/user\.role === "superadmin" \? \{ onlinePartnerIds/);
  assert.match(ws,/peer\.user\.role === "superadmin"\) emit\(peer\.socket, \{ type: "device-presence"/);
});
test("APIs antigas continuam inacessíveis a Admins, que só usam o namespace scoped",()=>{
  const routes=file("../../src/modules/admin.routes.js");
  assert.match(routes,/req\.user\?\.role === "admin" && !\//);
  assert.match(routes,/ADMIN_WORKSPACE_ONLY/);
  const auth=file("../../src/middleware/authenticate.js");
  assert.match(auth,/admin: \[\]/);
  assert.match(auth,/adminHasNetworkPermission\(user, perm\)/);
  const workspace=file("../../src/modules/admin-workspaces/workspace.routes.js");
  assert.match(workspace,/req\.networkOwnerId=req\.user\.id/);
  assert.match(workspace,/where:\{id,ownerAdminId:adminId/);
  assert.match(workspace,/where:\{key,ownerAdminId:root/);
  assert.match(workspace,/ownedPartner\(tenant\(req\),req\.valid\.params\.id/);
});
test("migração não transfere nem apaga clientes já cadastrados pela DeltaTV",()=>{
  const code=file("../../src/db/migrations/20261229000001-admin-workspaces.cjs");
  assert.match(code,/addColumn\("partners", "owner_admin_id"/);
  assert.match(code,/addColumn\("service_plan_catalogs", "owner_admin_id"/);
  assert.match(code,/allowNull: true/);
  assert.doesNotMatch(code,/DELETE FROM partners|TRUNCATE|DROP TABLE/i);
});

test("Ações de DNS, códigos, dispositivos e faturamento requerem dono e permissões",()=>{
 const source=file("../../src/modules/admin-workspaces/workspace.routes.js");
 for(const route of ['codes','providers','devices','invoices']){
   assert.match(source,new RegExp(`router\\.get\\("/partners/:id/${route}",requireScope\\("network:`));
 }
 assert.match(source,/await ownedPartner\(tenant\(req\),req\.valid\.params\.id\)/);
 assert.match(source,/licenseMonths:null/);
 assert.match(source,/ownerAdminId:adminId/);
 assert.doesNotMatch(source,/router\.(?:post|patch)\("\/vps/);
 const rights=normalizeNetworkPermissions(["network:resources:read","network:resources:write","network:devices:read","network:billing:read","network:billing:write"]);
 assert.equal(rights.length,5);
 assert.equal(adminHasNetworkPermission({role:"admin",delegatedPermissions:rights},"network:resources:write"),true);
});

test("As redes só oferecem planos compatíveis e não possuem operações globais de estoque",()=>{
 const code=file("../../src/modules/admin-workspaces/workspace.routes.js");
 assert.match(code,/kind !== "both" && plan\.audience === kind/);
 assert.doesNotMatch(code,/grantStock|adjustStock|partner_portal_stock/);
});

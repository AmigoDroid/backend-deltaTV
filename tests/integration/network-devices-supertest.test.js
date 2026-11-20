/** HTTP+Postgres integration: never substitute this with source-code regex tests.
 * To execute: npm install --no-save supertest &&
 * DATABASE_URL_TEST=postgres://... DELTA_DEVICE_TEST_DB_CONFIRM=DISPOSABLE \
 * NODE_ENV=test node --test tests/integration/network-devices-supertest.test.js
 * DATABASE_URL_TEST must target a disposable, already migrated database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL_TEST) {
  test("Supertest: escopo de dispositivos Admin A/B e rotas globais (requer DATABASE_URL_TEST)",
    { skip: "DATABASE_URL_TEST não definido; nenhuma integração HTTP/PostgreSQL executada" }, () => {});
} else {
  if (process.env.DELTA_DEVICE_TEST_DB_CONFIRM !== "DISPOSABLE")
    throw new Error("Banco de teste não confirmado. Defina DELTA_DEVICE_TEST_DB_CONFIRM=DISPOSABLE somente para PostgreSQL descartável.");
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  process.env.RATE_LIMIT_DISABLED = "true";
  // Importante: ausências de dependência aqui são falhas reais de preparação da integração.
  const [{ default: supertest }, { createApp }, db, { hashPassword }] = await Promise.all([
    import("supertest"), import("../../src/app.js"),
    import("../../src/db/models/index.js"), import("../../src/shared/crypto.js"),
  ]);
  const suffix = randomUUID().slice(0, 8);
  const password = "Test-only-network-devices-2026!";
  const http = supertest(createApp());
  const now = Date.now();
  const uniqueMac = n => `02:34:56:${suffix.slice(0, 2).toUpperCase()}:${suffix.slice(2, 4).toUpperCase()}:${String(n).padStart(2, "0")}`;
  const mkPartner = async (name, ownerAdminId) => db.Partner.create({
    name, slug: `${name.toLowerCase()}-${suffix}`, ownerAdminId, kind: "content",
    billingModel: "none", startsAt: new Date(now - 86400000), endsAt: new Date(now + 86400000 * 30),
  });
  async function account(name, delegatedPermissions) {
    return db.AdminUser.create({
      name, email: `network-devices-${name}-${suffix}@example.test`,
      passwordHash: await hashPassword(password), role: "admin", delegatedPermissions,
    });
  }
  async function auth(user) {
    const r = await http.post("/api/v1/auth/login").send({
      email: user.email, password, audience: "admin",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return `Bearer ${r.body.accessToken}`;
  }
  const endpoint = "/api/v1/admin/workspace/devices";
  test("Supertest: GET/DELETE/POST respeitam ownership; admin sem permissão recebe 403; /admin globais nunca escaláveis", async () => {
    const perms = ["network:devices:read", "network:devices:write"];
    const [a, b, reader, superuser] = await Promise.all([
      account("AdminA", perms), account("AdminB", perms),
      account("Reader", ["network:devices:read"]),
      db.AdminUser.create({name:`Root${suffix}`,email:`root-${suffix}@example.test`,
        passwordHash:await hashPassword(password),role:"superadmin"}),
    ]);
    const [pa, pb, pc] = await Promise.all([
      mkPartner(`PartnerA${suffix}`, a.id), mkPartner(`PartnerB${suffix}`, b.id),
      mkPartner(`PartnerC${suffix}`, reader.id),
    ]);
    const [da, dbb, dc] = await Promise.all([0, 1, 2].map(i => db.Device.create({mac:uniqueMac(i)})));
    const [aa, ab, ac] = await Promise.all([
      db.Activation.create({deviceId:da.id,mac:da.mac,partnerId:pa.id,status:"active",credentialsEnc:"v1.test-only-encrypted"}),
      db.Activation.create({deviceId:dbb.id,mac:dbb.mac,partnerId:pb.id,status:"active"}),
      db.Activation.create({deviceId:dc.id,mac:dc.mac,partnerId:pc.id,status:"active"}),
    ]);
    // O mesmo MAC físico pode servir a redes diferentes: somente o vínculo de cada uma é manipulável.
    const mixed = await db.Activation.create({deviceId:da.id,mac:da.mac,partnerId:pb.id,status:"active"});
    const [tokenA, tokenB, tokenRead, tokenRoot] = await Promise.all([auth(a),auth(b),auth(reader),auth(superuser)]);
    const listA = await http.get(`${endpoint}/by-mac`).set("Authorization",tokenA);
    assert.equal(listA.status,200,JSON.stringify(listA.body));
    assert.ok(listA.body.data.some(d => d.mac === da.mac));
    assert.ok(!listA.body.data.some(d => d.mac === dbb.mac));
    const listB = await http.get(`${endpoint}/by-mac`).set("Authorization",tokenB);
    assert.ok(listB.body.data.some(d => d.mac === dbb.mac));
    assert.ok(listB.body.data.some(d => d.mac === da.mac));
    for(const id of [dbb.id,dc.id]) {
      assert.equal((await http.get(`${endpoint}/registrations/${id}`).set("Authorization",tokenA)).status,404);
      assert.equal((await http.get(`${endpoint}/registrations/${id}/deletion-preview`).set("Authorization",tokenA)).status,404);
      assert.equal((await http.delete(`${endpoint}/registrations/${id}`).set("Authorization",tokenA)
        .send({confirmMac:id===dbb.id?dbb.mac:dc.mac,reason:"isolamento de rede"})).status,404);
      assert.equal((await http.post(`${endpoint}/registrations/${id}/block`).set("Authorization",tokenA)
        .send({reason:"isolamento de rede"})).status,404);
    }
    assert.equal((await http.get(`${endpoint}/history`).query({mac:dbb.mac}).set("Authorization",tokenA)).status,404);
    assert.equal((await http.get(`${endpoint}/registrations/${da.id}`).set("Authorization",tokenRead)).status,404);
    assert.equal((await http.post(`${endpoint}/registrations/${dc.id}/block`).set("Authorization",tokenRead)
      .send({reason:"sem delegação"})).status,403);
    for(const global of ["/api/v1/admin/system/vps","/api/v1/admin/system/vps/files",
      "/api/v1/admin/control","/api/v1/admin/users","/api/v1/admin/devices/by-mac"]) {
      assert.equal((await http.get(global).set("Authorization",tokenA)).status,403,global);
    }
    assert.equal((await http.post("/api/v1/admin/users").set("Authorization",tokenA)
      .send({role:"superadmin",name:"Intruso",email:"intruso@example.test"})).status,403);
    assert.equal((await http.post(`${endpoint}/bulk-action`).set("Authorization",tokenA)
      .send({ids:[da.id,dbb.id],action:"block",reason:"teste"})).status,404);
    assert.equal((await db.Activation.findByPk(aa.id)).status,"active","batch não pode alterar A antes do IDOR B");
    assert.equal((await db.Activation.findByPk(ab.id)).status,"active");
    // A própria rede é consultável e as globais continuam exclusivas da plataforma.
    const rootList = await http.get("/api/v1/admin/devices/by-mac").query({q:da.mac}).set("Authorization",tokenRoot);
    assert.equal(rootList.status,200);
    assert.ok(rootList.body.data.some(d=>d.mac===da.mac));
    // A desvinculação desaparece da lista padrão; as credenciais ficam cifradas no servidor
    // e são restauradas sem liberar o MAC pertencente a outra parceria.
    const revoked = await http.post(`${endpoint}/activations/${aa.id}/revoke`)
      .set("Authorization",tokenA).send({reason:"desvinculação de teste"});
    assert.equal(revoked.status,200,JSON.stringify(revoked.body));
    const afterRevoke = await http.get(`${endpoint}/by-mac`).set("Authorization",tokenA);
    assert.equal(afterRevoke.status,200);
    assert.ok(!afterRevoke.body.data.some(d=>d.mac===da.mac),"revogado não deve permanecer na lista padrão");
    const removedByFilter = await http.get(`${endpoint}/by-mac`).query({status:"revoked"}).set("Authorization",tokenA);
    assert.ok(removedByFilter.body.data.some(d=>d.mac===da.mac),"filtro removidos deve localizar vínculo revogado");
    assert.equal((await db.Activation.findByPk(aa.id)).credentialsEnc,null);
    assert.equal((await db.Activation.findByPk(aa.id)).recoveryCredentialsEnc,"v1.test-only-encrypted");
    const restored = await http.post(`${endpoint}/activations/${aa.id}/restore`).set("Authorization",tokenA).send({});
    assert.equal(restored.status,200,JSON.stringify(restored.body));
    assert.equal((await db.Activation.findByPk(aa.id)).credentialsEnc,"v1.test-only-encrypted");
    assert.equal((await db.Activation.findByPk(aa.id)).recoveryCredentialsEnc,null);
    assert.ok((await http.get(`${endpoint}/by-mac`).set("Authorization",tokenA)).body.data.some(d=>d.mac===da.mac));
    assert.equal((await db.Activation.findByPk(mixed.id)).status,"active");
    // O registro global do MAC não desaparece com a exclusão de um vínculo de rede.
    const removed = await http.delete(`${endpoint}/registrations/${da.id}`).set("Authorization",tokenA)
      .send({confirmMac:da.mac,reason:"limpeza da própria rede"});
    assert.equal(removed.status,200,JSON.stringify(removed.body));
    assert.equal(removed.body.deleted,true,JSON.stringify(removed.body));
    assert.ok(await db.Device.findByPk(da.id));
    assert.ok(await db.Activation.findByPk(ab.id));
    assert.ok(await db.Activation.findByPk(mixed.id));
    const after = await http.get(`${endpoint}/by-mac`).set("Authorization",tokenA);
    assert.ok(!after.body.data.some(d=>d.mac===da.mac));
    const stillB = await http.get(`${endpoint}/by-mac`).set("Authorization",tokenB);
    assert.ok(stillB.body.data.some(d=>d.mac===da.mac));
    // O banco é descartável, mas o caso não trunca nem apaga bases de terceiros.
    assert.ok(aa.id && ac.id);
  });
  test.after(async () => { await db.sequelize.close(); });
}

import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { activationLicenseJoin, deviceDisplayStatus } from "../../src/modules/devices/device-display-status.js";

test("classifica uma vez por aparelho e acompanha o vencimento e a conversão do teste", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE licenses (id integer, is_trial boolean, status text, starts_at timestamptz, expires_at timestamptz);
      CREATE TABLE activations (device_id integer, status text, license_id integer, granted_license_id integer);
      INSERT INTO licenses VALUES
        (1,true,'active',now()-interval '1 day',now()+interval '1 day'),
        (2,true,'active',now()-interval '2 days',now()-interval '1 day');
      INSERT INTO activations VALUES (1,'active',1,null),(2,'active',null,2),
        (3,'active',1,null),(3,'active',null,null),(4,'blocked',1,null),(5,'revoked',1,null);`);
    const states = async () => (await db.query(`SELECT ${deviceDisplayStatus} AS status FROM activations a
      ${activationLicenseJoin} GROUP BY a.device_id ORDER BY a.device_id`)).rows.map(row => row.status);
    assert.deepEqual(await states(), ["trial", "expired", "active", "blocked", "revoked"]);
    await db.exec("UPDATE licenses SET is_trial=false WHERE id=1");
    assert.deepEqual(await states(), ["active", "expired", "active", "blocked", "revoked"]);
    await db.exec("UPDATE licenses SET expires_at=CURRENT_TIMESTAMP WHERE id=2");
    assert.equal((await states())[1], "expired");
  } finally {
    await db.close();
  }
});

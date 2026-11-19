import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { canReceiveChange } from "../../src/realtime/routing-policy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const source = path => readFileSync(resolve(root,path),"utf8");

test("device broadcasts are restricted to the owner, including delegated admins", () => {
  assert.equal(canReceiveChange({role:"partner",partnerId:"a"},"a","admin-a"),true);
  assert.equal(canReceiveChange({role:"partner",partnerId:"b"},"a","admin-a"),false);
  assert.equal(canReceiveChange({role:"admin",id:"admin-a"},"a","admin-a"),true);
  assert.equal(canReceiveChange({role:"admin",id:"admin-b"},"a","admin-a"),false);
  assert.equal(canReceiveChange({role:"admin",id:"admin-a"},"a",null),false);
  assert.equal(canReceiveChange({role:"superadmin"},"a","admin-a"),true);
});
test("activation deletion routes require server-derived owners and strict inputs", () => {
  const portal=source("backend/src/modules/portal/portal.routes.js");
  const content=source("backend/src/modules/provider-monitor/partner-operations.routes.js");
  const admin=source("backend/src/modules/admin-workspaces/workspace.routes.js");
  for(const file of [portal,content]){
    assert.match(file,/router\.delete\("\/devices\/:id"/);
    assert.match(file,/devices\/bulk-\$\{action\}/);
    assert.match(file,/deleteScopedActivation\(req\.valid\.params\.id,req\.valid\.body,actorOf\(req\),scope\(req\)\)/);
    assert.match(file,/\.strict\(\)/);
  }
  assert.match(admin,/requireScope\("network:devices:write"\)/);
  assert.match(admin,/ownedPartner\(tenant\(req\),req\.valid\.params\.id\)/);
  const service=source("backend/src/modules/admin-deletion.service.js");
  assert.match(service,/if \(partnerId && String\(a\.partnerId\) !== String\(partnerId\)\)/);
  assert.match(service,/"ACTIVE_LICENSE"/);
  assert.match(service,/"CONFIRMATION_MISMATCH"/);
  assert.match(service,/action: "activation.delete.scoped"/);
  assert.match(service,/"ALREADY_REMOVED"/);
});
test("current-only filter is enforced in SQL and removed statuses remain filterable", () => {
  const service=source("backend/src/modules/devices/device.service.js");
  assert.match(service,/if \(!showRemoved\) where\.status/);
  assert.match(service,/if \(!status && !showRemoved\)/);
  assert.match(service,/"revoked"/);
});

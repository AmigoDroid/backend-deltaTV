import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const read = path => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const migration = require('../../src/db/migrations/20261123000002-client-app-public-qr.cjs');
const fakeSeq = {TEXT:'TEXT',JSONB:'JSONB',DATE:'DATE'};
function mockQ(){const calls=[];const q={sequelize:{transaction:async fn=>fn('T')},addColumn:async(t,c)=>calls.push(`add:${t}.${c}`),removeColumn:async(t,c)=>calls.push(`remove:${t}.${c}`)};return{q,calls};}

test('V4 migration up/down adds only QR metadata and lock fields',async()=>{
 const {q,calls}=mockQ();await migration.up(q,fakeSeq);await migration.down(q);
 assert.deepEqual(calls,['add:client_apps.logo_url','add:client_apps.theme','add:device_pairing_tokens.qr_link_in_progress_at',
  'remove:device_pairing_tokens.qr_link_in_progress_at','remove:client_apps.theme','remove:client_apps.logo_url']);
});
test('QR token is issued only for custom apps, not Build 68 legacy',()=>{
 const s=read('modules/devices/registration.service.js');
 assert.match(s,/\.\.\.\(context \? \{ qrToken: decryptSecret/);
 assert.match(s,/registrationToken: decryptSecret/);
 assert.match(s,/!active \|\| recoverable/);
});
test('QR access rejects wrong app, MAC, used or expired token',()=>{
 const s=read('modules/client-apps/client-app-public.service.js');
 assert.match(s,/clientAppId: appId/);assert.match(s,/registrationUsedAt: null/);
 assert.match(s,/tokenHash: sha256\(token\)/);assert.match(s,/expiresAt: \{ \[Op\.gt\]: new Date\(\) \}/);
 assert.match(s,/if \(!known\) throw invalidQr\(\)/);
});
test('QR link never sends session tokens to public browser',()=>{
 const r=read('modules/client-apps/client-app-public.routes.js');
 const srv=read('modules/client-apps/client-app-public.service.js');
 assert.match(r,/linkFromPublicQr/);assert.match(srv,/return \{ ok: true \}/);
 assert.doesNotMatch(srv,/return .*accessToken|return .*refreshToken/);
 assert.match(srv,/await activatePrepared/);
});
test('QR validation is POST, not a token in a GET URL',()=>{
 const r=read('modules/client-apps/client-app-public.routes.js');
 assert.match(r,/router\.get\('\/:identifier'/);
 assert.match(r,/router\.post\('\/:identifier\/verify'/);
 assert.doesNotMatch(r,/query: z\.object\(\{ mac: mac/);
});
test('Race control and audit preserve credential confidentiality',()=>{
 const s=read('modules/client-apps/client-app-public.service.js');
 assert.match(s,/qrLinkInProgressAt/);assert.match(s,/locked\.update\(\{ qrLinkInProgressAt:/);
 assert.match(s,/row\.update\(\{ usedAt: new Date\(\), qrLinkInProgressAt: null \}/);
 assert.doesNotMatch(s,/metadata: \{[^}]*username|metadata: \{[^}]*password/);
});
test('Legacy URL and partner-code public registration cannot configure custom apps',()=>{
 const r=read('modules/activations/client.routes.js');const s=read('modules/devices/playlist-by-url.service.js');
 assert.match(r,/if \(binding && req\.valid\.body\.code\) throw unavailable/);
 assert.match(s,/if \(device\.clientAppId\) throw new AppError\(403, "APP_NOT_AVAILABLE"/);
});
test('Partner origin restricted to only new public routes',()=>{
 const app=read('app.js');
 assert.match(app,/origin === env\.partnerPortalUrl && \/\^/);
 assert.match(app,/env\.corsOrigins\.includes\(origin\)/);
});

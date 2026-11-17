import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inviteUnavailable,inviteRecipient,remainingUses} from '../../src/modules/admin-workspaces/network-invite.policy.js';
const src=relative=>readFileSync(new URL(`../../src/${relative}`,import.meta.url),'utf8');
test('links sem e-mail podem ser enviados para usuários diferentes e respeitam usos',()=>{
 const invite={email:null,useCount:2,maxUses:5,expiresAt:'2030-01-01T00:00:00Z',revokedAt:null,acceptedAt:null};
 assert.equal(inviteUnavailable(invite,new Date('2026-01-01')),false);
 assert.equal(inviteRecipient(invite,' PESSOA@EMAIL.COM '),'pessoa@email.com');
 assert.equal(remainingUses(invite),3);
 assert.equal(inviteUnavailable({...invite,useCount:5},new Date('2026-01-01')),true);
 assert.equal(inviteUnavailable({...invite,revokedAt:new Date()},new Date('2026-01-01')),true);
 assert.equal(inviteUnavailable({...invite,expiresAt:'2024-01-01'},new Date('2026-01-01')),true);
});
test('convite pessoal antigo continua de uso único e e-mail fixo',()=>{
 const old={email:'a@b.com',maxUses:1,useCount:0,acceptedAt:null,expiresAt:'2030-01-01'};
 assert.equal(inviteRecipient(old,'falso@cliente.com'),'a@b.com');
 assert.equal(inviteUnavailable({...old,acceptedAt:new Date()},new Date('2026-01-01')),true);
 assert.equal(inviteUnavailable({...old,useCount:1},new Date('2026-01-01')),true);
});
test('uso ilimitado e-mail opcional',()=>{
 const link={email:null,maxUses:null,useCount:100,expiresAt:'2030-01-01'};
 assert.equal(remainingUses(link),null);
 assert.equal(inviteUnavailable(link,new Date('2026-01-01')),false);
});
test('cadastro por convite e remoção de parceiro são isolados por propriedade',()=>{
 const pub=src('modules/admin-workspaces/network-invite-public.routes.js');
 const del=src('modules/admin-deletion.service.js');
 const route=src('modules/admin-workspaces/workspace.routes.js');
 const migration=src('db/migrations/20270101000001-shareable-network-invitations.cjs');
 assert.match(pub,/lock:t\.LOCK\.UPDATE/);
 assert.match(pub,/AdminNetworkInviteRedemption\.create/);
 assert.match(pub,/ownerAllowed\(r,t\)/);
 assert.match(del,/partner\.ownerAdminId!==scopeOwnerId/);
 assert.match(route,/canDeleteOwned\(req,p\)/);
 assert.match(migration,/use_count/);
 assert.match(migration,/ck_admin_network_invite_uses/);
});

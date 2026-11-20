import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNetworkPermissions, adminHasNetworkPermission } from '../../src/modules/admin-workspaces/permissions.js';

test('configurar gateway inclui leitura do próprio gateway, sem liberar finanças ou recursos globais', () => {
  const delegatedPermissions = normalizeNetworkPermissions(['network:gateways:write']);
  const admin = {role:'admin', delegatedPermissions};
  assert.equal(adminHasNetworkPermission(admin,'network:gateways:read'),true);
  assert.equal(adminHasNetworkPermission(admin,'network:gateways:write'),true);
  assert.equal(adminHasNetworkPermission(admin,'network:billing:read'),false);
  assert.equal(adminHasNetworkPermission(admin,'network:partners:read'),false);
  assert.equal(adminHasNetworkPermission(admin,'vps:write'),false);
});

test('remover escrita preserva leitura quando concedida; permissões estranhas não entram', () => {
  assert.deepEqual(normalizeNetworkPermissions(['network:gateways:read']), ['network:gateways:read']);
  assert.deepEqual(normalizeNetworkPermissions(['vps:write','network:gateways:read']),['network:gateways:read']);
  assert.deepEqual(normalizeNetworkPermissions([]),[]);
});

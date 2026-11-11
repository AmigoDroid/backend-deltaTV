import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuality } from '../../src/modules/provider-monitor/quality-policy.js';
import { commandPayload } from '../../src/realtime/remote-payload.js';

test('nenhuma TV isolada derruba servidor de todos os parceiros',()=>{
  assert.equal(classifyQuality({sampleDevices:1,affectedDevices:1}).severity,'normal');
  assert.equal(classifyQuality({sampleDevices:100,affectedDevices:4}).severity,'normal');
  assert.equal(classifyQuality({sampleDevices:10,affectedDevices:5}).severity,'warning');
  assert.equal(classifyQuality({sampleDevices:10,affectedDevices:7}).severity,'critical');
});
test('amostras vazias não geram falso alerta nem divisão por zero',()=>{
  const sample=classifyQuality({sampleDevices:0,affectedDevices:0,sampleEvents:0});
  assert.equal(sample.affectedPercent,0);
  assert.equal(sample.severity,'normal');
});
test('mensagem curta e intervalos têm validação no backend',()=>{
  assert.equal(commandPayload('show-message',{note:'  Manutenção hoje  '}).text,'Manutenção hoje');
  assert.throws(()=>commandPayload('show-message',{note:'a'}),{code:'MESSAGE_INVALID'});
  assert.equal(commandPayload('set-telemetry',{telemetryIntervalSeconds:90}).telemetryIntervalSeconds,90);
  assert.throws(()=>commandPayload('set-telemetry',{telemetryIntervalSeconds:2}),{code:'INVALID_INTERVAL'});
  assert.equal(commandPayload('ping',{note:'nada'}),null);
});

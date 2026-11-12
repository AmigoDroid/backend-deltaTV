import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceOnline, livePlayback, liveForDevice } from '../../src/realtime/live-snapshot.js';
import { percent } from '../../src/modules/provider-monitor/availability-math.js';

test('3.000 TVs: snapshots isolados, limitados e sem URL/credencial', () => {
  for (let i=0; i<3000; i++) {
    const id = `device-${i}`;
    deviceOnline(id, { ip: '192.0.2.15', launchId: '48a7d157-0299-445b-92b1-8bb9612fad68' });
    livePlayback(id, { state:'playing', playback_id:`watch-${i}`, title:'Filme A',kind:'movie',
      position:120, duration:3600, bitrate_kbps:4500, build:'63', url:'https://user:pass@secret' }, '192.0.2.15');
  }
  const snapshot = liveForDevice('device-100');
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.playback.title, 'Filme A');
  assert.equal(snapshot.ip,'192.0.2.15');
  assert.equal(snapshot.usage.sessions24h, 1);
  assert.ok(!JSON.stringify(snapshot).includes('pass@secret'));
  assert.equal(liveForDevice('device-missing').online, false);
});
test('retransmissão não acrescenta sessões; estado terminado remove reprodução', () => {
  const id = 'tested';
  livePlayback(id,{state:'playing',playback_id:'same',title:'Série',kind:'series',position:10});
  livePlayback(id,{state:'playing',playback_id:'same',title:'Série',kind:'series',position:20});
  assert.equal(liveForDevice(id).usage.sessions24h, 1);
  livePlayback(id,{state:'finished',playback_id:'same',title:'Série',kind:'series',position:30});
  assert.equal(liveForDevice(id).playback, null);
});
test('disponibilidade reporta sem dados, falha e bons resultados', () => {
  assert.equal(percent(0,0),null);
  assert.equal(percent(60,60),100);
  assert.equal(percent(59,60),98.33);
  assert.equal(percent(0,4),0);
});

test('nova abertura limpa reprodução antiga sem apagar contadores anônimos', () => {
  const id='reopen-test';
  const first='48a7d157-0299-445b-92b1-8bb9612fad68';
  const next='38a7d157-0299-445b-92b1-8bb9612fad69';
  deviceOnline(id,{ip:'203.0.113.7',launchId:first});
  livePlayback(id,{state:'playing',playback_id:'session-one',title:'Filme antigo',kind:'movie'});
  assert.equal(liveForDevice(id).playback.title,'Filme antigo');
  deviceOnline(id,{ip:'203.0.113.7',launchId:first});
  assert.equal(liveForDevice(id).playback.title,'Filme antigo');
  deviceOnline(id,{ip:'203.0.113.7',launchId:next});
  assert.equal(liveForDevice(id).playback,null);
  assert.equal(liveForDevice(id).usage.sessions24h,1);
});

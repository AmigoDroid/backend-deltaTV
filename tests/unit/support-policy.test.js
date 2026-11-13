import test from 'node:test';
import assert from 'node:assert/strict';
import { selectClientActivations } from '../../src/modules/support/support.policy.js';
const base={partnerId:'revenda-a',mac:'AA:BB:CC:DD:EE:FF'};
const act=(p='revenda-a',deviceId='tv-1',mac=base.mac)=>({partnerId:p,deviceId,mac});
test('não cruza clientes de revendas com mesmo MAC',()=>{
 const x=selectClientActivations(base,[act('revenda-a'),act('revenda-b')]);
 assert.equal(x.matches.length,1);assert.equal(x.ambiguous,false);
});
test('não escolhe entre dois dispositivos canônicos com o mesmo MAC',()=>{
 const x=selectClientActivations(base,[act('revenda-a','tv-1'),act('revenda-a','tv-2')]);
 assert.equal(x.matches.length,0);assert.equal(x.ambiguous,true);
});
test('vínculo canônico explícito vence, mas sinaliza conflito',()=>{
 const x=selectClientActivations({...base,deviceId:'tv-2'},[act('revenda-a','tv-1'),act('revenda-a','tv-2')]);
 assert.equal(x.matches.length,1);assert.equal(x.matches[0].deviceId,'tv-2');assert.equal(x.ambiguous,true);
});
test('não associa MAC diferente só porque device id coincide',()=>{
 const x=selectClientActivations({...base,deviceId:'tv-1'},[act('revenda-a','tv-1','00:00:00:00:00:00')]);
 assert.equal(x.matches.length,0);
});

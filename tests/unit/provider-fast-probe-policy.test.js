import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleXtreamResponse, smoothLatency } from '../../src/modules/provider-monitor/probe-policy.js';
import { healthTransition } from '../../src/modules/provider-monitor/health-policy.js';

test('sondagem não considera página 404, 403, 429 ou HTML como Xtream válido',()=>{
  for(const status of [403,404,429,500]) assert.equal(isPlausibleXtreamResponse({status,contentType:'application/json',sample:'{}'}),false);
  assert.equal(isPlausibleXtreamResponse({status:200,contentType:'text/html',sample:'<html>login</html>'}),false);
  assert.equal(isPlausibleXtreamResponse({status:200,contentType:'application/json',sample:'<html>login</html>'}),false);
  assert.equal(isPlausibleXtreamResponse({status:200,contentType:'application/json',sample:'{"user_info":{"auth":0}}'}),true);
});
test('média móvel evita trocar DNS por ruído pequeno',()=>{
  assert.equal(smoothLatency(100,200),135);
  assert.equal(smoothLatency(null,150),150);
  assert.equal(smoothLatency(100,-1),100);
});
test('duas falhas confirmadas levam servidor para down',()=>{
  const a=healthTransition({failures:0,successes:2,state:'healthy'},{good:false});
  assert.equal(a.state,'suspect');
  const b=healthTransition(a,{good:false});
  assert.equal(b.state,'down');
});

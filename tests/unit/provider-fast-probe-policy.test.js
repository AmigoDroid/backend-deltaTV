import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleXtreamResponse, smoothLatency } from '../../src/modules/provider-monitor/probe-policy.js';
import { healthTransition } from '../../src/modules/provider-monitor/health-policy.js';

test('401, 403 e 404 indicam HTTP alcançável na sondagem sem credenciais; 429 e 5xx não',()=>{
  for(const status of [401,403,404]) assert.equal(isPlausibleXtreamResponse({status,contentType:'text/html',sample:'<html>restrito</html>'}),true);
  for(const status of [429,500,503]) assert.equal(isPlausibleXtreamResponse({status,contentType:'application/json',sample:'{}'}),false);
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

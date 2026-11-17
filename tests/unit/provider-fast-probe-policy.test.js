import test from 'node:test';
import assert from 'node:assert/strict';
import { isReachableHttpStatus, smoothLatency } from '../../src/modules/provider-monitor/probe-policy.js';
import { healthTransition } from '../../src/modules/provider-monitor/health-policy.js';

test('sondagem HTTP segue a classificação anterior: 200..499, exceto 429',()=>{
  for(const status of [200,204,301,302,307,400,401,403,404,418,499])
    assert.equal(isReachableHttpStatus(status),true,`HTTP ${status}`);
  for(const status of [100,199,429,500,503,599,undefined,null,NaN])
    assert.equal(isReachableHttpStatus(status),false,`HTTP ${status}`);
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

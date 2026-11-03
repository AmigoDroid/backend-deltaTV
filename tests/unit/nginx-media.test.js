import test from 'node:test';
import assert from 'node:assert/strict';
import {pinnedMediaTarget,assertNginxMediaGateway,NGINX_MEDIA_MARKER} from '../../src/shared/nginx-media.js';
test('media target pins the connection IP, retaining original Host and TLS name',()=>{
 const actual=pinnedMediaTarget('https://media.example.com:8443/movie/u/p/1.mp4?x=1','8.8.8.8');
 assert.equal(actual.target,'https://8.8.8.8:8443/movie/u/p/1.mp4?x=1');assert.equal(actual.host,'media.example.com:8443');assert.equal(actual.tlsName,'media.example.com');
});
test('mapped IPv4 and public IPv6 are pinned without adding a new DNS lookup',()=>{
 assert.equal(pinnedMediaTarget('http://example.com/a','::ffff:8.8.8.8').target,'http://8.8.8.8/a');assert.equal(pinnedMediaTarget('https://example.com/a','2606:4700:4700::1111').target,'https://[2606:4700:4700::1111]/a');
});
test('private addresses and URL userinfo are refused before delegation',()=>{
 const old=process.env.ALLOW_PRIVATE_SOURCES;process.env.ALLOW_PRIVATE_SOURCES='false';
 try{assert.throws(()=>pinnedMediaTarget('http://example.com/a','127.0.0.1'),{code:'ORIGIN_NOT_ALLOWED'});assert.throws(()=>pinnedMediaTarget('http://user:password@example.com/a','8.8.8.8'),{code:'INVALID_URL'});}finally{if(old===undefined)delete process.env.ALLOW_PRIVATE_SOURCES;else process.env.ALLOW_PRIVATE_SOURCES=old;}
});
test('missing gateway configuration produces an actionable failure instead of empty media',()=>{
 assert.throws(()=>assertNginxMediaGateway({headers:{}}),{code:'NGINX_MEDIA_NOT_CONFIGURED'});assert.doesNotThrow(()=>assertNginxMediaGateway({headers:{'x-delta-media-gateway':NGINX_MEDIA_MARKER}}));
});

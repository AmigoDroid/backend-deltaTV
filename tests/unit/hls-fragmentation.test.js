import test from 'node:test';
import assert from 'node:assert/strict';
import {readMediaHead,isPlaylistHead} from '../../src/modules/sources/hls-rewrite.js';
async function* chunks(parts){for(const part of parts)yield Buffer.from(part)}
test('HLS identification survives a header split across TCP chunks',async()=>{
 const iterator=chunks(['#EXT','M','3U\n','segment.ts\n']);const first=await readMediaHead(iterator);assert.equal(isPlaylistHead(first.value),true);assert.equal((await iterator.next()).value.toString(),'segment.ts\n');
});
test('UTF-8 BOM and whitespace may also arrive separately',async()=>{
 const iterator=chunks([Buffer.from([0xef]),Buffer.from([0xbb]),Buffer.from([0xbf]),'\n','#EX','TM3U\n']);assert.equal(isPlaylistHead((await readMediaHead(iterator)).value),true);
});
test('binary media is not buffered waiting for a playlist signature',async()=>{
 let consumed=0;async function* source(){consumed++;yield Buffer.from([0x47]);consumed++;yield Buffer.alloc(188)}
 const first=await readMediaHead(source());assert.equal(consumed,1);assert.equal(first.value.length,1);assert.equal(isPlaylistHead(first.value),false);
});
test('empty and short non-playlist streams retain all bytes',async()=>{
 assert.equal((await readMediaHead(chunks([]))).done,true);const first=await readMediaHead(chunks(['#EX']));assert.equal(first.done,false);assert.equal(first.value.toString(),'#EX');assert.equal(isPlaylistHead(first.value),false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {generateWebCode,generateWebMac,WEB_CODE_RE} from "../../src/modules/web/web-code.js";
test("web codes are two uppercase letters plus six digits",()=>{const seen=new Set();for(let i=0;i<100;i++){const v=generateWebCode();assert.match(v,WEB_CODE_RE);seen.add(v)}assert.ok(seen.size>97)});
test("web virtual MACs are formatted and locally administered",()=>{for(let i=0;i<20;i++)assert.match(generateWebMac(),/^02:57:45:[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/)});

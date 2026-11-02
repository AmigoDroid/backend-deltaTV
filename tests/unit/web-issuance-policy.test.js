import test from "node:test";
import assert from "node:assert/strict";
import {webIssuePolicy} from "../../src/modules/web/issuance-policy.js";
const issuer={id:"reseller-1",kind:"reseller",status:"active"};
const owner={id:"content-2",kind:"content",status:"active"};
const own={...issuer};
const stockCode={licenseMonths:1,allowWebIssuance:false};
const contentCode={licenseMonths:null,allowWebIssuance:true};
test("self-stock code debits its owner and needs a license duration",()=>{
 assert.deepEqual(webIssuePolicy({issuer,owner:own,code:stockCode}),{allowed:true,funding:"reseller_stock"});
 assert.equal(webIssuePolicy({issuer,owner:own,code:{licenseMonths:null}}).allowed,false);
});
test("content codes require explicit account and code opt-in plus negotiated contract",()=>{
 assert.deepEqual(webIssuePolicy({issuer,owner,code:contentCode,terms:{mode:"credits",allowWebIssuance:true}}),{allowed:true,funding:"content_partner_contract"});
 for(const mode of ["fixed_unlimited","fixed_limited"]){assert.equal(webIssuePolicy({issuer,owner,code:contentCode,terms:{mode,allowWebIssuance:true}}).allowed,true)}
 for(const terms of [{mode:"legacy",allowWebIssuance:true},{mode:"credits",allowWebIssuance:false}])assert.equal(webIssuePolicy({issuer,owner,code:contentCode,terms}).allowed,false);
 assert.equal(webIssuePolicy({issuer,owner,code:{...contentCode,allowWebIssuance:false},terms:{mode:"credits",allowWebIssuance:true}}).allowed,false);
});
test("never charge both stock and content contract",()=>{
 assert.equal(webIssuePolicy({issuer,owner,code:stockCode,terms:{mode:"credits",allowWebIssuance:true}}).allowed,false);
});
test("inactive and non-reseller issuers are denied",()=>{
 for(const bad of [{...issuer,status:"blocked"},{...issuer,kind:"content"}])assert.equal(webIssuePolicy({issuer:bad,owner,code:contentCode,terms:{mode:"credits",allowWebIssuance:true}}).allowed,false);
});

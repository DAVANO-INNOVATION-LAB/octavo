import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
const file=new URL('../src/lib/.oidc-settings-test.ts',import.meta.url);
let count=0, fail=false;
globalThis.__oidcTest={discovery:async()=>{count++;if(fail)throw new Error('temporary discovery outage');return {test:true};},allowInsecureRequests:()=>{}};
writeFileSync(file,readFileSync(new URL('../src/lib/oidc.ts',import.meta.url),'utf8').replace('import "server-only";','').replace('import * as oidc from "openid-client";','const oidc = globalThis.__oidcTest;').replace('import { getSetting } from "./settings";','const getSetting = () => null;').replace('import { claimOptions, type ClaimOptions } from "./oidc-claims";', 'const claimOptions = () => ({});').replace('import { resolveSecretSource } from "./secret-source";', 'const resolveSecretSource = () => { if (globalThis.__oidcSecretError) throw new Error("synthetic-sensitive-path"); return null; };').replace('import { decryptSecret } from "./crypto";','const decryptSecret = (value: string) => value;'));
try {
 const {discover,oidcSettings,oidcMissingFields}=await import(file.href);globalThis.__oidcSecretError=true;assert.equal(oidcSettings(),null);assert.deepEqual(oidcMissingFields(),["OIDC configuration is invalid or the configured credential is unavailable"]);delete globalThis.__oidcSecretError;const base={issuer:'https://id.example.test',clientId:'one',clientSecret:'first'};
 await discover(base);await discover(base);assert.equal(count,1);
 await discover({...base,clientId:'two'});assert.equal(count,2);
 await discover({...base,clientSecret:'rotated'});assert.equal(count,3);
 fail=true;await assert.rejects(discover({...base,clientSecret:'retry'}));
 fail=false;await discover({...base,clientSecret:'retry'});assert.equal(count,5);
 console.log('PASS OIDC settings cache: reuse, client change, secret rotation, retry after failed discovery.');
} finally {rmSync(file,{force:true});delete globalThis.__oidcTest;delete globalThis.__octavoOidcConfig;}

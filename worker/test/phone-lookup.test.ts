import { test } from "node:test";
import assert from "node:assert/strict";
import { isVoip, lookupPhone, parseLookup, phoneLookupConfig } from "../src/phone-lookup.ts";

test("parseLookup: assigned mobile, VoIP, invalid (404 or valid=false), odd answers", () => {
  assert.deepEqual(parseLookup(200, { valid: true, line_type_intelligence: { type: "mobile", carrier_name: "T-Mobile USA, Inc." } }), { valid: true, type: "mobile", carrier: "T-Mobile USA, Inc." });
  assert.deepEqual(parseLookup(200, { valid: true, line_type_intelligence: { type: "nonFixedVoip", carrier_name: "Google (Grand Central) - SVR" } }), { valid: true, type: "nonFixedVoip", carrier: "Google (Grand Central) - SVR" });
  assert.deepEqual(parseLookup(404, { code: 20404 }), { valid: false, type: "invalid", carrier: null });
  assert.deepEqual(parseLookup(200, { valid: false, line_type_intelligence: null }), { valid: false, type: "invalid", carrier: null });
  // 60600 "unprovisioned or out of coverage": the real answer for both numbers SimpleCheck could not verify (2026-11-10) → invalid
  assert.deepEqual(parseLookup(200, { valid: true, validation_errors: [], line_type_intelligence: { carrier_name: null, error_code: 60600, type: null } }), { valid: false, type: "invalid", carrier: null });
  // any other add-on error: still a valid number, type unknown
  assert.deepEqual(parseLookup(200, { valid: true, line_type_intelligence: { type: null, error_code: 60601 } }), { valid: true, type: "unknown", carrier: null });
  assert.deepEqual(parseLookup(200, { valid: true, line_type_intelligence: { type: "hologram" } }), { valid: true, type: "unknown", carrier: null });
  assert.equal(parseLookup(401, { message: "Authenticate" }), null);
  assert.equal(parseLookup(500, null), null);
});

test("lookupPhone never throws: a network failure or a 5xx is null, a 404 is invalid", async () => {
  const cfg = { accountSid: "AC1", keySid: "SK1", keySecret: "s" };
  const boom = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
  assert.equal(await lookupPhone(cfg, "+13125550100", boom), null);
  const notFound = (async () => new Response(JSON.stringify({ code: 20404 }), { status: 404 })) as unknown as typeof fetch;
  assert.deepEqual(await lookupPhone(cfg, "+13125550100", notFound), { valid: false, type: "invalid", carrier: null });
  let seen: { url: string; auth: string | null } | null = null;
  const ok = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization ?? null };
    return new Response(JSON.stringify({ valid: true, line_type_intelligence: { type: "landline", carrier_name: "AT&T" } }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await lookupPhone(cfg, "+13125550100", ok), { valid: true, type: "landline", carrier: "AT&T" });
  assert.equal(seen!.url, "https://lookups.twilio.com/v2/PhoneNumbers/%2B13125550100?Fields=line_type_intelligence");
  assert.equal(seen!.auth, `Basic ${btoa("SK1:s")}`);
});

test("config needs all three secrets; VoIP = the two voip types", () => {
  assert.equal(phoneLookupConfig({ TWILIO_ACCOUNT_SID: "AC", TWILIO_API_KEY_SID: "SK" }), null);
  assert.deepEqual(phoneLookupConfig({ TWILIO_ACCOUNT_SID: "AC", TWILIO_API_KEY_SID: "SK", TWILIO_API_KEY_SECRET: "x" }), { accountSid: "AC", keySid: "SK", keySecret: "x" });
  assert.equal(isVoip("nonFixedVoip"), true);
  assert.equal(isVoip("fixedVoip"), true);
  assert.equal(isVoip("mobile"), false);
  assert.equal(isVoip(null), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, identityKey, offerAmounts, parseResponse, runPreQualification, splitName } from "../src/simplecheck.ts";

const input = { name: "Jane Doe", email: "jane.doe@sample-roofing.com", phone: "+18135550142", consentIp: "203.0.113.42" };

test("splitName needs a first and a last name and keeps only letters, spaces, apostrophes, hyphens", () => {
  assert.deepEqual(splitName("Jane Doe"), { firstName: "Jane", lastName: "Doe" });
  assert.deepEqual(splitName("  María José O'Neil-Smith Jr. "), { firstName: "Maria", lastName: "Jose O'Neil-Smith" });
  assert.deepEqual(splitName("Mary Ann De La Cruz"), { firstName: "Mary", lastName: "Ann De La Cruz" });
  assert.equal(splitName("Jane"), null);
  assert.equal(splitName("Jane 42"), null);
  assert.equal(splitName("Jane D0e 3rd"), null);
  assert.equal(splitName("Jane & John Doe"), null);
  assert.equal(splitName(""), null);
  assert.equal(splitName(null), null);
});

test("splitName turns 'Last, First' around and drops titles, suffixes and middle initials", () => {
  assert.deepEqual(splitName("Doe, Jane"), { firstName: "Jane", lastName: "Doe" });
  assert.deepEqual(splitName("John Smith, Jr."), { firstName: "John", lastName: "Smith" });
  assert.deepEqual(splitName("Dr. John M. Smith III"), { firstName: "John", lastName: "Smith" });
  assert.deepEqual(splitName("John M Smith"), { firstName: "John", lastName: "Smith" });
  assert.equal(splitName("Dr. Smith"), null);
  assert.equal(splitName("Smith Jr"), null);
});

test("identityKey is stable across formatting and differs per person", async () => {
  const a = await identityKey("Jane Doe", "Jane.Doe@Sample-Roofing.com", "+1 (813) 555-0142");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await identityKey("  jane   DOE ", "jane.doe@sample-roofing.com", "8135550142"), a);
  assert.notEqual(await identityKey("John Doe", "jane.doe@sample-roofing.com", "8135550142"), a);
  assert.notEqual(await identityKey("Jane Doe", "other@sample-roofing.com", "8135550142"), a);
  assert.notEqual(await identityKey("Jane Doe", "jane.doe@sample-roofing.com", "8135550143"), a);
});

test("buildRequest sends the token in the body with the nested shape from the reference", () => {
  const req = buildRequest("tok_123", input);
  assert.deepEqual(req, {
    ok: true,
    body: {
      api_token: "tok_123",
      data: { firstName: "Jane", lastName: "Doe", email: "jane.doe@sample-roofing.com", phone: "8135550142", ConsentIP: "203.0.113.42" },
    },
  });
});

test("buildRequest refuses to call without a last name, email, phone or consent IP", () => {
  assert.deepEqual(buildRequest("t", { ...input, name: "Jane" }), { ok: false, reason: "name_not_checkable" });
  assert.deepEqual(buildRequest("t", { ...input, email: " " }), { ok: false, reason: "no_email" });
  assert.deepEqual(buildRequest("t", { ...input, phone: "555" }), { ok: false, reason: "no_phone" });
  assert.deepEqual(buildRequest("t", { ...input, consentIp: "unknown" }), { ok: false, reason: "no_consent_ip" });
  assert.deepEqual(buildRequest("t", { ...input, consentIp: null }), { ok: false, reason: "no_consent_ip" });
});

/** The success body from the SimpleCheck API reference (2026-11-09). */
const SUCCESS = {
  Code: "200",
  Offers: {
    OfferID1: 7672009, OfferID2: 7672010, OfferName1: "Automatic Financing", OfferScore1: 733,
    OfferAmount1: "$25,000", OfferAmount2: "$72,000", OfferStatus1: "Approved",
    OfferDetails1: "Financing Automatically and Instantly Available", OfferDebtToIncome1: 16,
  },
  Status: "Success",
  DataEnhance: { DataEnhanceDebtToIncome: 16 },
  CreditFreeze: "No",
  DataPerfection: {
    DOB: { Age: "56" },
    Emails: ["jane.doe@example.com", "jane.d@example.com"],
    Income: { Estimate: 60000, Personal: 60000, Household: 92000 },
    Phones: [],
    Addresses: { Zip1: "90210", City1: "Beverly Hills", State1: "CA", Address1: "123 Example St" },
  },
  api_request_count: 29901,
  PreQualificationID: 3928570,
};

test("parseResponse keeps the credit figures and drops the enrichment block", () => {
  const r = parseResponse(200, SUCCESS);
  assert.deepEqual(r, {
    status: "success", prequalId: 3928570, score: 733, offerStatus: "Approved", offerAmount1: "$25,000",
    offerAmount2: "$72,000", dti: 16, income: 60000, householdIncome: 92000, creditFreeze: "No",
  });
  assert.equal(JSON.stringify(r).includes("Beverly"), false);
  assert.equal(JSON.stringify(r).includes("jane.d@"), false);
});

test("parseResponse: a success without offers is a success with no score", () => {
  const r = parseResponse(200, { Code: "200", Status: "Success", PreQualificationID: 1 });
  assert.equal(r.status, "success");
  assert.equal(r.status === "success" && r.score, null);
});

test("parseResponse: HTTP 200 with Code 201 is a validation failure, not a success", () => {
  assert.deepEqual(parseResponse(200, { Code: "201", Status: "Failure", Errors: ["Email is not in a valid format.", "Last name is required."] }), {
    status: "invalid", error: "Email is not in a valid format. Last name is required.",
  });
  assert.equal(parseResponse(200, { Code: "201" }).status, "invalid");
});

test("parseResponse: a 200 that is neither success nor a validation failure stays retryable", () => {
  assert.deepEqual(parseResponse(200, null), { status: "error", http: 200, error: "unexpected response" });
  assert.deepEqual(parseResponse(200, "<html>maintenance</html>"), { status: "error", http: 200, error: "unexpected response" });
  assert.deepEqual(parseResponse(200, {}), { status: "error", http: 200, error: "unexpected response" });
  assert.equal(parseResponse(200, { Code: "200", Status: "Failure", Errors: ["x"] }).status, "invalid");
});

test("parseResponse: queued, auth and server errors carry no vendor text", () => {
  assert.deepEqual(parseResponse(202, { message: "API is stopped; request queued", queued: true, queue_id: 9 }), {
    status: "queued", error: "account paused, request queued",
  });
  assert.deepEqual(parseResponse(401, { error: "Invalid API token" }), { status: "error", http: 401, error: "HTTP 401" });
  assert.deepEqual(parseResponse(500, null), { status: "error", http: 500, error: "HTTP 500" });
  assert.deepEqual(parseResponse(429, {}), { status: "error", http: 429, error: "HTTP 429" });
});

test("runPreQualification posts JSON to the Qualify endpoint and never puts the token in the URL", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(SUCCESS), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await runPreQualification("tok_secret", input, fake);
  assert.equal(r.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.simplecheck.ai/api/pre-qualification");
  assert.equal(calls[0].url.includes("tok_secret"), false);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(JSON.parse(String(calls[0].init.body)).api_token, "tok_secret");
});

test("runPreQualification makes no request when the input cannot be checked, and maps a network failure", async () => {
  let called = 0;
  const never = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
  assert.deepEqual(await runPreQualification("t", { ...input, name: "Jane" }, never), { status: "skipped", error: "name_not_checkable" });
  assert.equal(called, 0);
  const boom = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  assert.deepEqual(await runPreQualification("t", input, boom), { status: "error", error: "network error" });
  const slow = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
  assert.deepEqual(await runPreQualification("t", input, slow), { status: "error", error: "timeout" });
});

test("runPreQualification never returns the token inside an error text", async () => {
  const echo = (async () => new Response(JSON.stringify({ Code: "201", Status: "Failure", Errors: ["bad token tok_secret given"] }), { status: 200 })) as unknown as typeof fetch;
  const r = await runPreQualification("tok_secret", input, echo);
  assert.deepEqual(r, { status: "invalid", error: "bad token <token> given" });
});

test("offerAmounts joins distinct amounts", () => {
  assert.equal(offerAmounts({ offerAmount1: "$25,000", offerAmount2: "$72,000" }), "$25,000 / $72,000");
  assert.equal(offerAmounts({ offerAmount1: "$25,000", offerAmount2: "$25,000" }), "$25,000");
  assert.equal(offerAmounts({ offerAmount1: null, offerAmount2: null }), null);
});

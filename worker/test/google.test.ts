import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { MEET_SCOPE, parseServiceAccount, serviceAccountToken, signAssertion } from "../src/google.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = { client_email: "meet@project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string };

test("parseServiceAccount accepts a key file and rejects anything else", () => {
  assert.deepEqual(parseServiceAccount(JSON.stringify({ ...sa, type: "service_account" })), sa);
  assert.equal(parseServiceAccount(undefined), null);
  assert.equal(parseServiceAccount("not json"), null);
  assert.equal(parseServiceAccount(JSON.stringify({ client_email: "x", private_key: "nope" })), null);
});

test("signAssertion produces an RS256 JWT for the host that Google's public key check would accept", async () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const jwt = await signAssertion(sa, "calvin@startroofrejuvenating.com", MEET_SCOPE, now);
  const [h, c, sig] = jwt.split(".");
  const dec = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());
  assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(dec(c), { iss: sa.client_email, sub: "calvin@startroofrejuvenating.com", scope: MEET_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now / 1000, exp: now / 1000 + 3600 });
  const v = createVerify("RSA-SHA256"); v.update(`${h}.${c}`);
  assert.equal(v.verify(publicKey, Buffer.from(sig, "base64url")), true);
});

test("serviceAccountToken returns the access token and names the host in its error", async () => {
  const ok = (async () => new Response(JSON.stringify({ access_token: "ya29.x" }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await serviceAccountToken(sa, "calvin@startroofrejuvenating.com", MEET_SCOPE, ok), "ya29.x");
  const denied = (async () => new Response(JSON.stringify({ error: "unauthorized_client" }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(serviceAccountToken(sa, "michael@stonesystems.io", MEET_SCOPE, denied), /michael@stonesystems.io → 401 unauthorized_client/);
});

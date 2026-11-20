/**
 * Standard Webhooks v1 signing (https://www.standardwebhooks.com), with WebCrypto.
 *
 *   webhook-id        unique per delivery
 *   webhook-timestamp unix seconds
 *   webhook-signature "v1,<base64 HMAC-SHA256 over `${id}.${timestamp}.${body}`>"
 *
 * The key is the UTF-8 bytes of the secret as stored (no "whsec_" base64 decoding), which is what the CSP's
 * verifier expects. The receiver checks the signature over the raw body and rejects a stale timestamp.
 */

function base64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** "v1,<base64 HMAC-SHA256>" for one delivery. */
export async function signStandardWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`));
  return `v1,${base64(mac)}`;
}

/** The three headers for one delivery of `body`. `now` (ms) and `id` are injectable for tests. */
export async function standardWebhookHeaders(
  secret: string, body: string, now: number = Date.now(), id: string = `msg_${crypto.randomUUID()}`,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(now / 1000);
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": await signStandardWebhook(secret, id, timestamp, body),
  };
}

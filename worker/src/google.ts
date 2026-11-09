/**
 * Google access tokens from a service account with domain-wide delegation: the Worker signs a JWT with the
 * account's private key and asks Google for a token that acts as one Workspace user (the call's host).
 * Nobody authorizes anything by hand; a new closer is covered the moment their Workspace account exists.
 * Scopes must be listed under Admin console → Security → API controls → Domain-wide delegation.
 */

export type ServiceAccount = { client_email: string; private_key: string };

export const MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";

/** The JSON key file Google downloads, or null when the secret is unset or not a key file. */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ServiceAccount>;
    return typeof v.client_email === "string" && typeof v.private_key === "string" && v.private_key.includes("PRIVATE KEY") ? { client_email: v.client_email, private_key: v.private_key } : null;
  } catch {
    return null;
  }
}

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** The signed assertion for `subject`, valid for one hour. Exported for tests; callers want `serviceAccountToken`. */
export async function signAssertion(sa: ServiceAccount, subject: string, scope: string, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, sub: subject, scope, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

/**
 * An access token acting as `subject`. Throws with Google's error code when the account is outside the
 * delegated domain or the scope is not delegated ("unauthorized_client"), so callers can log and skip that host.
 */
export async function serviceAccountToken(sa: ServiceAccount, subject: string, scope: string, fetchImpl: typeof fetch = fetch, nowMs: number = Date.now()): Promise<string> {
  const assertion = await signAssertion(sa, subject, scope, nowMs);
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google token for ${subject} → ${res.status} ${data.error ?? ""}`.trim());
  return data.access_token;
}

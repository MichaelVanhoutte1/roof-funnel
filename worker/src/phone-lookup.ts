/**
 * Carrier lookup of an applicant's phone number: Twilio Lookup v2 with line_type_intelligence.
 * Michael, 2026-11-10: run on Stone Systems' Twilio account for now ("it'd be easy to check the numbers").
 *
 * Used once per number when a lead is saved. An unassigned / invalid number is refused at the phone step; the line
 * type (mobile, landline, VoIP …) is kept on the lead for the team. Any failure of the lookup itself lets the lead
 * through — a vendor outage must never cost a lead.
 */

export type PhoneLookupConfig = { accountSid: string; keySid: string; keySecret: string };

/** Twilio's line types, plus "invalid" for a number Twilio says is not a real, assigned number. */
export type LineType = "mobile" | "landline" | "fixedVoip" | "nonFixedVoip" | "tollFree" | "premium" | "sharedCost" | "uan" | "voicemail" | "pager" | "unknown" | "invalid";

export type PhoneLookup = { valid: boolean; type: LineType; carrier: string | null };

export const LOOKUP_TIMEOUT_MS = 4_000;

export function phoneLookupConfig(env: { TWILIO_ACCOUNT_SID?: string; TWILIO_API_KEY_SID?: string; TWILIO_API_KEY_SECRET?: string }): PhoneLookupConfig | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET) return null;
  return { accountSid: env.TWILIO_ACCOUNT_SID, keySid: env.TWILIO_API_KEY_SID, keySecret: env.TWILIO_API_KEY_SECRET };
}

const TYPES = new Set<LineType>(["mobile", "landline", "fixedVoip", "nonFixedVoip", "tollFree", "premium", "sharedCost", "uan", "voicemail", "pager", "unknown"]);

/** Line Type Intelligence: "Unprovisioned or out of coverage" — no carrier has this number. Seen live on both numbers SimpleCheck could not verify. */
const UNPROVISIONED = 60600;

/**
 * What one Lookup v2 answer says. HTTP 404 = Twilio does not know the number (invalid). A 200 with valid=false, or
 * with the line-type add-on reporting the number unprovisioned, is invalid too. Otherwise the line type comes from
 * line_type_intelligence.type when the add-on answered; "unknown" when it could not (other error codes).
 */
export function parseLookup(httpStatus: number, body: unknown): PhoneLookup | null {
  if (httpStatus === 404) return { valid: false, type: "invalid", carrier: null };
  if (httpStatus !== 200 || !body || typeof body !== "object") return null;
  const b = body as { valid?: unknown; line_type_intelligence?: { type?: unknown; carrier_name?: unknown; error_code?: unknown } | null };
  if (b.valid === false) return { valid: false, type: "invalid", carrier: null };
  const lti = b.line_type_intelligence ?? null;
  if (lti?.error_code === UNPROVISIONED) return { valid: false, type: "invalid", carrier: null };
  const rawType = typeof lti?.type === "string" ? lti.type : "unknown";
  const type = (TYPES.has(rawType as LineType) ? rawType : "unknown") as LineType;
  const carrier = typeof lti?.carrier_name === "string" && lti.carrier_name.trim() ? lti.carrier_name.trim().slice(0, 80) : null;
  return { valid: true, type, carrier };
}

/** One lookup; null when Twilio could not be asked (network, auth, timeout) — never throws. */
export async function lookupPhone(cfg: PhoneLookupConfig, e164: string, fetchImpl: typeof fetch = fetch): Promise<PhoneLookup | null> {
  try {
    const res = await fetchImpl(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`, {
      headers: { Authorization: `Basic ${btoa(`${cfg.keySid}:${cfg.keySecret}`)}`, Accept: "application/json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    const parsed = parseLookup(res.status, body);
    if (!parsed) console.error("[phone] lookup answered", res.status);
    return parsed;
  } catch (err) {
    console.error("[phone] lookup failed:", String(err).slice(0, 120));
    return null;
  }
}

/** True for a line type the team would want flagged (not a phone in someone's pocket or on their desk). */
export function isVoip(type: string | null | undefined): boolean {
  return type === "fixedVoip" || type === "nonFixedVoip";
}

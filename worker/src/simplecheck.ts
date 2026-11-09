/**
 * SimpleCheck Qualify API client: one soft-pull pre-qualification for a lead who submitted the
 * application under the soft credit check disclosure.
 *
 * Reference (portal → Developer API, 2026-11-09): POST https://api.simplecheck.ai/api/pre-qualification,
 * token in the JSON body (Bearer headers are not accepted), HTTP 200 is not success on its own —
 * `Status` must be "Success". The same token + email + phone + name within 7 days returns the cached
 * result without a second charge.
 */
const ENDPOINT = "https://api.simplecheck.ai/api/pre-qualification";
const SOURCE = "startroofrejuvenating-funnel";
/** Leaves room for the Slack and GHL writes inside the Worker's 30 s background budget. */
const TIMEOUT_MS = 15_000;

export type CreditInput = { name?: string | null; email?: string | null; phone?: string | null; consentIp?: string | null };

export type CreditReport = {
  prequalId: number | null;
  score: number | null;
  offerStatus: string | null;
  offerAmount1: string | null;
  offerAmount2: string | null;
  /** Debt-to-income as a percentage (16 = 16%). */
  dti: number | null;
  income: number | null;
  householdIncome: number | null;
  creditFreeze: string | null;
};

export type CreditResult =
  | ({ status: "success" } & CreditReport)
  /** SimpleCheck refused the input (bad name, email, phone or consent IP). Nothing was pulled. */
  | { status: "invalid"; error: string }
  /** The SimpleCheck account is paused; the request was queued on their side. */
  | { status: "queued"; error: string }
  /** We did not call SimpleCheck (missing last name, missing IP, …). */
  | { status: "skipped"; error: string }
  /** Transport or server failure; safe to retry later. */
  | { status: "error"; error: string };

/**
 * SimpleCheck accepts letters, spaces, apostrophes and hyphens only, and needs a first and a last name.
 * Accents, periods and commas are normalised away; a name with anything else (digits, symbols) is not
 * rewritten into something the person never typed — it is simply not checked.
 */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } | null {
  const clean = (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[.,]/g, " ")
    .trim();
  if (/[^A-Za-z' -]/.test(clean)) return null;
  const parts = clean.split(/\s+/).filter((p) => /[A-Za-z]/.test(p));
  if (parts.length < 2) return null;
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** The request body, or the reason no request can be made. */
export function buildRequest(
  token: string,
  input: CreditInput,
): { ok: true; body: Record<string, unknown> } | { ok: false; reason: string } {
  const name = splitName(input.name);
  if (!name) return { ok: false, reason: "name_not_checkable" };
  const email = (input.email ?? "").trim();
  if (!email) return { ok: false, reason: "no_email" };
  const phone = (input.phone ?? "").replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) return { ok: false, reason: "no_phone" };
  const consentIp = (input.consentIp ?? "").trim();
  if (!consentIp || consentIp === "unknown") return { ok: false, reason: "no_consent_ip" };
  return {
    ok: true,
    body: { api_token: token, data: { firstName: name.firstName, lastName: name.lastName, email, phone, ConsentIP: consentIp } },
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function text(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Map an HTTP status + parsed JSON body to a result. Only the figures the closer needs are kept;
 * the enrichment block (addresses, alternate emails, age) is deliberately not read.
 */
export function parseResponse(httpStatus: number, raw: unknown): CreditResult {
  const body = obj(raw);
  if (httpStatus === 202 || body.queued === true) return { status: "queued", error: text(body.message) ?? "queued" };
  if (httpStatus !== 200) return { status: "error", error: `HTTP ${httpStatus}: ${text(body.error) ?? text(body.message) ?? "no detail"}` };
  if (body.Status !== "Success" && body.Code !== "200") {
    const errors = Array.isArray(body.Errors) ? body.Errors.filter((e): e is string => typeof e === "string") : [];
    return { status: "invalid", error: (errors.join(" ") || text(body.Status) || "validation failure").slice(0, 300) };
  }
  const offers = obj(body.Offers);
  const income = obj(obj(body.DataPerfection).Income);
  return {
    status: "success",
    prequalId: num(body.PreQualificationID),
    score: num(offers.OfferScore1),
    offerStatus: text(offers.OfferStatus1),
    offerAmount1: text(offers.OfferAmount1, 40),
    offerAmount2: text(offers.OfferAmount2, 40),
    dti: num(offers.OfferDebtToIncome1) ?? num(obj(body.DataEnhance).DataEnhanceDebtToIncome),
    income: num(income.Estimate) ?? num(income.Personal),
    householdIncome: num(income.Household),
    creditFreeze: text(body.CreditFreeze, 20),
  };
}

export async function runPreQualification(
  token: string,
  input: CreditInput,
  fetchImpl: typeof fetch = fetch,
  /** Override for local runs against a stub; production always uses the real endpoint. */
  endpoint: string = ENDPOINT,
): Promise<CreditResult> {
  const req = buildRequest(token, input);
  if (!req.ok) return { status: "skipped", error: req.reason };
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Source": SOURCE },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.json().catch(() => null);
    return parseResponse(res.status, raw);
  } catch (err) {
    // The error text can never contain the token: it travels in the body, not the URL.
    return { status: "error", error: String(err).slice(0, 200) };
  }
}

/** "$25,000 / $72,000", one amount, or null. */
export function offerAmounts(r: Pick<CreditReport, "offerAmount1" | "offerAmount2">): string | null {
  const parts = [r.offerAmount1, r.offerAmount2].filter((a): a is string => !!a);
  const unique = parts.filter((a, i) => parts.indexOf(a) === i);
  return unique.length ? unique.join(" / ") : null;
}

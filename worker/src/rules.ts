/**
 * Disqualification rules, edited on the admin page and applied when a lead is routed.
 * A lead is disqualified when any answer it gave is switched on here, or when its soft credit check
 * result breaks a credit rule. Disqualified leads are stored like everyone else but never see the calendar.
 *
 * Credit rules come in two columns, one per capital answer: "cash" (has $20k now) and "financing". Michael's reading
 * of the data (2026-11-10): people who claim cash with a sub-580 score are lying, people who need financing but are
 * offered under $10k cannot buy — so each answer needs its own floor.
 */
import { BUSINESS_OWNER_OPTIONS, CAPITAL_DQ_VALUE, CAPITAL_OPTIONS, TIMELINE_OPTIONS } from "./validation.ts";
import type { CreditReport } from "./simplecheck.ts";

export const RULE_QUESTIONS = [
  { key: "timeline", label: "How soon are you planning to become a dealer?", options: TIMELINE_OPTIONS },
  { key: "business_owner", label: "Business owner, or looking to start one?", options: BUSINESS_OWNER_OPTIONS },
  { key: "capital", label: "$20,000 in accessible capital?", options: CAPITAL_OPTIONS },
] as const;

export type QuestionKey = (typeof RULE_QUESTIONS)[number]["key"];

export type CreditThresholds = {
  /** Disqualify below this credit score. */
  minScore: number | null;
  /** Disqualify when the largest financing amount offered is below this (or nothing was offered). A report with no credit file is the `noScore` switch's call, not this rule's. */
  minOfferAmount: number | null;
  /** Disqualify below this estimated yearly income. Leads with no income estimate are not blocked. */
  minIncome: number | null;
};

export type CapitalKind = "cash" | "financing";

export type CreditRules = {
  /** Floors for leads who said they have the money now. */
  cash: CreditThresholds;
  /** Floors for leads who said they will use financing. */
  financing: CreditThresholds;
  /** Disqualify when the check ran but found no credit file / score (either answer). */
  noScore: boolean;
  /** Disqualify when the credit file is frozen (either answer). */
  creditFreeze: boolean;
};

export type Rules = { answers: Record<QuestionKey, Record<string, boolean>>; credit: CreditRules };

export type Answers = { timeline?: string | null; business_owner?: string | null; capital?: string | null };

const NO_THRESHOLDS: CreditThresholds = { minScore: null, minOfferAmount: null, minIncome: null };

/** What the funnel did before rules were editable: only the "No" capital answer is turned away. */
export const DEFAULT_RULES: Rules = {
  answers: { timeline: {}, business_owner: {}, capital: { [CAPITAL_DQ_VALUE]: true } },
  credit: { cash: { ...NO_THRESHOLDS }, financing: { ...NO_THRESHOLDS }, noScore: false, creditFreeze: false },
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function threshold(v: unknown, max: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.round(n), max);
}

function thresholds(raw: unknown): CreditThresholds {
  const t = obj(raw);
  return { minScore: threshold(t.minScore, 850), minOfferAmount: threshold(t.minOfferAmount, 10_000_000), minIncome: threshold(t.minIncome, 100_000_000) };
}

/** Accept whatever was stored or posted and return a well-formed rule set (unknown keys and answers are dropped). */
export function normalizeRules(raw: unknown): Rules {
  const src = obj(raw);
  const srcAnswers = obj(src.answers);
  const answers = {} as Rules["answers"];
  for (const q of RULE_QUESTIONS) {
    const given = obj(srcAnswers[q.key]);
    const out: Record<string, boolean> = {};
    for (const option of q.options) if (given[option] === true) out[option] = true;
    answers[q.key] = out;
  }
  const c = obj(src.credit);
  let cash: CreditThresholds, financing: CreditThresholds;
  if ("cash" in c || "financing" in c) {
    cash = thresholds(c.cash);
    financing = thresholds(c.financing);
  } else {
    // The earlier one-column shape: thresholds at the root, applied to everyone or to financing answers only.
    const legacy = thresholds(c);
    financing = legacy;
    cash = c.appliesTo === "financing" ? { ...NO_THRESHOLDS } : { ...legacy };
  }
  return { answers, credit: { cash, financing, noScore: c.noScore === true, creditFreeze: c.creditFreeze === true } };
}

/** "answer:<question>" for the first answer that is switched to disqualify, or null. */
export function answerDqReason(rules: Rules, a: Answers): string | null {
  for (const key of ["capital", "timeline", "business_owner"] as const) {
    const value = a[key];
    if (value && rules.answers[key][value] === true) return `answer:${key}`;
  }
  return null;
}

/** Qualified on the answers so far: the capital question has a real answer and nothing given is disqualifying. */
export function answersQualify(rules: Rules, a: Answers): boolean {
  return !!a.capital && (CAPITAL_OPTIONS as readonly string[]).includes(a.capital) && answerDqReason(rules, a) === null;
}

/** Which credit column a lead's capital answer falls under; null when it is not a "Yes" answer. */
export function capitalKind(capital: string | null | undefined): CapitalKind | null {
  const v = (capital ?? "").trim();
  if (/financing/i.test(v)) return "financing";
  if (/^yes/i.test(v)) return "cash";
  return null;
}

function anyThreshold(t: CreditThresholds): boolean {
  return t.minScore !== null || t.minOfferAmount !== null || t.minIncome !== null;
}

/** True when a credit rule is switched on for this lead's capital answer, so routing has to wait for the check. */
export function creditRulesApply(rules: Rules, a: Answers): boolean {
  const kind = capitalKind(a.capital);
  if (!kind) return false;
  return anyThreshold(rules.credit[kind]) || rules.credit.noScore || rules.credit.creditFreeze;
}

/** "$25,000" → 25000. */
export function parseMoney(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && /\d/.test(v) ? n : null;
}

/** The largest financing amount the report offers, or null when it offers none. */
export function bestOfferAmount(r: Pick<CreditReport, "offerAmount1" | "offerAmount2">): number | null {
  const amounts = [parseMoney(r.offerAmount1), parseMoney(r.offerAmount2)].filter((n): n is number => n !== null);
  return amounts.length ? Math.max(...amounts) : null;
}

/**
 * "credit:<rule>" for the first credit rule a successful report breaks, judged under the column of the lead's capital
 * answer, or null. Only called with a report that came back: a check that could not run never disqualifies anyone.
 */
export function creditDqReason(rules: Rules, r: CreditReport, a: Answers): string | null {
  const c = rules.credit;
  if (c.creditFreeze && /^y/i.test(r.creditFreeze ?? "")) return "credit:freeze";
  if (r.score === null) return c.noScore ? "credit:no_score" : null;
  const kind = capitalKind(a.capital);
  if (!kind) return null;
  const t = c[kind];
  if (t.minScore !== null && r.score < t.minScore) return "credit:min_score";
  if (t.minOfferAmount !== null && (bestOfferAmount(r) ?? 0) < t.minOfferAmount) return "credit:min_offer";
  if (t.minIncome !== null && r.income !== null && r.income < t.minIncome) return "credit:min_income";
  return null;
}

/** What the visitor may be told: the capital answer has its own message, everything else is one neutral message. */
export function publicDqKind(reason: string | null): "capital" | "other" {
  return reason === "answer:capital" ? "capital" : "other";
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerDqReason, answersQualify, bestOfferAmount, capitalKind, creditDqReason, creditRulesApply, DEFAULT_RULES, normalizeRules, parseMoney, publicDqKind, type Rules } from "../src/rules.ts";
import type { CreditReport } from "../src/simplecheck.ts";

const YES_CASH = "Yes, I have $20,000+ available right now.";
const YES_FIN = "Yes, I will use financing.";
const NO = "No, I do not qualify to book a call.";
const report = (over: Partial<CreditReport> = {}): CreditReport => ({
  prequalId: 1, score: 700, offerStatus: "Approved", offerAmount1: "$25,000", offerAmount2: null, dti: 10, income: 60000, householdIncome: 90000, creditFreeze: "No", ...over,
});
const OFF = { minScore: null, minOfferAmount: null, minIncome: null };
type Col = Partial<Rules["credit"]["cash"]>;
const withCredit = (o: { cash?: Col; financing?: Col; noScore?: boolean; creditFreeze?: boolean }): Rules => ({
  ...DEFAULT_RULES,
  credit: { cash: { ...OFF, ...o.cash }, financing: { ...OFF, ...o.financing }, noScore: !!o.noScore, creditFreeze: !!o.creditFreeze },
});
const CASH = { capital: YES_CASH }, FIN = { capital: YES_FIN };

test("default rules reproduce the old funnel: only the No capital answer is turned away", () => {
  assert.equal(answerDqReason(DEFAULT_RULES, { timeline: "More than 30 days", business_owner: "I want to start one", capital: YES_FIN }), null);
  assert.equal(answerDqReason(DEFAULT_RULES, { timeline: "Right away", business_owner: "I own a business", capital: NO }), "answer:capital");
  assert.equal(answersQualify(DEFAULT_RULES, CASH), true);
  assert.equal(answersQualify(DEFAULT_RULES, { capital: NO }), false);
  assert.equal(answersQualify(DEFAULT_RULES, { timeline: "Right away" }), false); // capital not answered yet
  assert.equal(answersQualify(DEFAULT_RULES, { capital: "anything else" }), false); // not one of the survey's answers
  assert.equal(creditRulesApply(DEFAULT_RULES, FIN), false);
  assert.equal(creditRulesApply(DEFAULT_RULES, CASH), false);
});

test("an answer switched to disqualify turns that answer away and names the question", () => {
  const rules = normalizeRules({ answers: { timeline: { "More than 30 days": true }, business_owner: { "I want to start one": true }, capital: { [NO]: true } } });
  assert.equal(answerDqReason(rules, { timeline: "More than 30 days", business_owner: "I own a business", capital: YES_CASH }), "answer:timeline");
  assert.equal(answerDqReason(rules, { timeline: "Right away", business_owner: "I want to start one", capital: YES_CASH }), "answer:business_owner");
  assert.equal(answerDqReason(rules, { timeline: "More than 30 days", business_owner: "I want to start one", capital: NO }), "answer:capital");
  assert.equal(answersQualify(rules, { timeline: "More than 30 days", capital: YES_CASH }), false);
  assert.equal(answerDqReason(rules, { timeline: "Right away", business_owner: "I own a business", capital: YES_CASH }), null);
});

test("normalizeRules: two credit columns, junk dropped, thresholds capped", () => {
  const r = normalizeRules({
    answers: { timeline: { "Right away": true, "Someday": true, "Within 30 days": "yes" }, hacked: { x: true }, capital: null },
    credit: { cash: { minScore: "580", minOfferAmount: -1, extra: 1 }, financing: { minOfferAmount: "$10,000", minIncome: "" }, noScore: 1, creditFreeze: true, extra: 1 },
  });
  assert.deepEqual(r.answers, { timeline: { "Right away": true }, business_owner: {}, capital: {} });
  assert.deepEqual(r.credit, {
    cash: { minScore: 580, minOfferAmount: null, minIncome: null },
    financing: { minScore: null, minOfferAmount: 10000, minIncome: null },
    noScore: false, creditFreeze: true,
  });
  assert.deepEqual(normalizeRules(null), { answers: { timeline: {}, business_owner: {}, capital: {} }, credit: DEFAULT_RULES.credit });
  assert.equal(normalizeRules({ credit: { cash: { minScore: 5000 } } }).credit.cash.minScore, 850);
});

test("normalizeRules: the earlier one-column shape is carried over", () => {
  // "everyone" → both columns; "financing" → the financing column only
  const all = normalizeRules({ credit: { appliesTo: "all", minScore: 620, minOfferAmount: "$10,000" } }).credit;
  assert.deepEqual([all.cash, all.financing], [{ minScore: 620, minOfferAmount: 10000, minIncome: null }, { minScore: 620, minOfferAmount: 10000, minIncome: null }]);
  const fin = normalizeRules({ credit: { appliesTo: "financing", minOfferAmount: 10000, noScore: true } }).credit;
  assert.deepEqual([fin.cash, fin.financing, fin.noScore], [OFF, { minScore: null, minOfferAmount: 10000, minIncome: null }, true]);
});

test("capital answer → column; credit rules apply per column, the switches to both", () => {
  assert.equal(capitalKind(YES_CASH), "cash");
  assert.equal(capitalKind(YES_FIN), "financing");
  assert.equal(capitalKind(NO), null);
  assert.equal(capitalKind(null), null);
  const rules = withCredit({ cash: { minScore: 580 }, financing: { minOfferAmount: 10000 } });
  assert.equal(creditRulesApply(rules, CASH), true);
  assert.equal(creditRulesApply(rules, FIN), true);
  assert.equal(creditRulesApply(withCredit({ financing: { minOfferAmount: 10000 } }), CASH), false);
  assert.equal(creditRulesApply(withCredit({ financing: { minOfferAmount: 10000 } }), FIN), true);
  assert.equal(creditRulesApply(withCredit({ noScore: true }), CASH), true);
  assert.equal(creditRulesApply(withCredit({ cash: { minScore: 580 } }), { capital: NO }), false);
});

test("creditDqReason judges under the lead's own column: Michael's 2026-11-10 rules", () => {
  const rules = withCredit({ cash: { minScore: 580 }, financing: { minOfferAmount: 10000 } });
  // cash claim, 543 and $1,000: out. Same file under financing: $1,000 < $10k, also out — for the other reason.
  assert.equal(creditDqReason(rules, report({ score: 543, offerAmount1: "$1,000" }), CASH), "credit:min_score");
  assert.equal(creditDqReason(rules, report({ score: 543, offerAmount1: "$1,000" }), FIN), "credit:min_offer");
  // cash claim at 583 with nothing offered stays in (the cash column has no offer floor)
  assert.equal(creditDqReason(rules, report({ score: 583, offerAmount1: null }), CASH), null);
  // financing at 712 with $25,000 stays in; at 712 with $5,000 is out
  assert.equal(creditDqReason(rules, report({ score: 712, offerAmount1: "$25,000" }), FIN), null);
  assert.equal(creditDqReason(rules, report({ score: 712, offerAmount1: "$5,000" }), FIN), "credit:min_offer");
  assert.equal(creditDqReason(rules, report({ offerAmount1: "$5,000", offerAmount2: "$72,000" }), FIN), null);
  // a "No" answer never reaches the credit columns
  assert.equal(creditDqReason(rules, report({ score: 300 }), { capital: NO }), null);
});

test("creditDqReason: income, no file and freeze", () => {
  assert.equal(creditDqReason(withCredit({ cash: { minIncome: 50000 } }), report({ income: 40000 }), CASH), "credit:min_income");
  assert.equal(creditDqReason(withCredit({ cash: { minIncome: 50000 } }), report({ income: null }), CASH), null);
  assert.equal(creditDqReason(withCredit({ creditFreeze: true }), report({ creditFreeze: "Yes" }), FIN), "credit:freeze");
  assert.equal(creditDqReason(withCredit({ creditFreeze: true }), report({ creditFreeze: "No" }), FIN), null);
  // a report with no score is only turned away by the no-file switch
  assert.equal(creditDqReason(withCredit({ cash: { minScore: 620, minOfferAmount: 10000 } }), report({ score: null, offerAmount1: null }), CASH), null);
  assert.equal(creditDqReason(withCredit({ noScore: true }), report({ score: null }), CASH), "credit:no_score");
  assert.equal(creditDqReason(DEFAULT_RULES, report({ score: 300, offerAmount1: null, income: 0 }), CASH), null);
});

test("money parsing and the visitor-facing reason", () => {
  assert.equal(parseMoney("$25,000"), 25000);
  assert.equal(parseMoney("1,000.50"), 1000.5);
  assert.equal(parseMoney("n/a"), null);
  assert.equal(parseMoney(null), null);
  assert.equal(bestOfferAmount({ offerAmount1: "$25,000", offerAmount2: "$72,000" }), 72000);
  assert.equal(bestOfferAmount({ offerAmount1: null, offerAmount2: null }), null);
  assert.equal(publicDqKind("answer:capital"), "capital");
  assert.equal(publicDqKind("credit:min_score"), "other");
  assert.equal(publicDqKind("answer:timeline"), "other");
});

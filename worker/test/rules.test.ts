import { test } from "node:test";
import assert from "node:assert/strict";
import { answerDqReason, answersQualify, bestOfferAmount, creditDqReason, creditRulesApply, DEFAULT_RULES, normalizeRules, parseMoney, publicDqKind, type Rules } from "../src/rules.ts";
import type { CreditReport } from "../src/simplecheck.ts";

const YES_CASH = "Yes, I have $20,000+ available right now.";
const YES_FIN = "Yes, I will use financing.";
const NO = "No, I do not qualify to book a call.";
const report = (over: Partial<CreditReport> = {}): CreditReport => ({
  prequalId: 1, score: 700, offerStatus: "Approved", offerAmount1: "$25,000", offerAmount2: null, dti: 10, income: 60000, householdIncome: 90000, creditFreeze: "No", ...over,
});
const withCredit = (credit: Partial<Rules["credit"]>): Rules => ({ ...DEFAULT_RULES, credit: { ...DEFAULT_RULES.credit, ...credit } });

test("default rules reproduce the old funnel: only the No capital answer is turned away", () => {
  assert.equal(answerDqReason(DEFAULT_RULES, { timeline: "More than 30 days", business_owner: "I want to start one", capital: YES_FIN }), null);
  assert.equal(answerDqReason(DEFAULT_RULES, { timeline: "Right away", business_owner: "I own a business", capital: NO }), "answer:capital");
  assert.equal(answersQualify(DEFAULT_RULES, { capital: YES_CASH }), true);
  assert.equal(answersQualify(DEFAULT_RULES, { capital: NO }), false);
  assert.equal(answersQualify(DEFAULT_RULES, { timeline: "Right away" }), false); // capital not answered yet
  assert.equal(answersQualify(DEFAULT_RULES, { capital: "anything else" }), false); // not one of the survey's answers
  assert.equal(creditRulesApply(DEFAULT_RULES, { capital: YES_FIN }), false);
});

test("an answer switched to disqualify turns that answer away and names the question", () => {
  const rules = normalizeRules({ answers: { timeline: { "More than 30 days": true }, business_owner: { "I want to start one": true }, capital: { [NO]: true } } });
  assert.equal(answerDqReason(rules, { timeline: "More than 30 days", business_owner: "I own a business", capital: YES_CASH }), "answer:timeline");
  assert.equal(answerDqReason(rules, { timeline: "Right away", business_owner: "I want to start one", capital: YES_CASH }), "answer:business_owner");
  assert.equal(answerDqReason(rules, { timeline: "More than 30 days", business_owner: "I want to start one", capital: NO }), "answer:capital");
  assert.equal(answersQualify(rules, { timeline: "More than 30 days", capital: YES_CASH }), false);
  assert.equal(answerDqReason(rules, { timeline: "Right away", business_owner: "I own a business", capital: YES_CASH }), null);
});

test("normalizeRules drops unknown questions, unknown answers and junk thresholds", () => {
  const r = normalizeRules({
    answers: { timeline: { "Right away": true, "Someday": true, "Within 30 days": "yes" }, hacked: { x: true }, capital: null },
    credit: { appliesTo: "everyone", minScore: "620", minOfferAmount: "$10,000", minIncome: -5, noScore: 1, creditFreeze: true, extra: 1 },
  });
  assert.deepEqual(r.answers, { timeline: { "Right away": true }, business_owner: {}, capital: {} });
  assert.deepEqual(r.credit, { appliesTo: "all", minScore: 620, minOfferAmount: 10000, minIncome: null, noScore: false, creditFreeze: true });
  assert.deepEqual(normalizeRules(null), { answers: { timeline: {}, business_owner: {}, capital: {} }, credit: DEFAULT_RULES.credit });
  assert.equal(normalizeRules({ credit: { minScore: 5000 } }).credit.minScore, 850);
});

test("credit rules apply to everyone or to financing answers only", () => {
  assert.equal(creditRulesApply(withCredit({ minScore: 620 }), { capital: YES_CASH }), true);
  assert.equal(creditRulesApply(withCredit({ minScore: 620, appliesTo: "financing" }), { capital: YES_CASH }), false);
  assert.equal(creditRulesApply(withCredit({ minScore: 620, appliesTo: "financing" }), { capital: YES_FIN }), true);
  assert.equal(creditRulesApply(withCredit({ noScore: true }), { capital: YES_CASH }), true);
});

test("creditDqReason: score, financing amount, income, no file, freeze", () => {
  assert.equal(creditDqReason(withCredit({ minScore: 620 }), report({ score: 606 })), "credit:min_score");
  assert.equal(creditDqReason(withCredit({ minScore: 620 }), report({ score: 620 })), null);
  // the real 2026-11-09 result: 606, "Approved" for $1,000
  assert.equal(creditDqReason(withCredit({ minOfferAmount: 10000 }), report({ score: 606, offerAmount1: "$1,000" })), "credit:min_offer");
  assert.equal(creditDqReason(withCredit({ minOfferAmount: 10000 }), report({ offerAmount1: "$5,000", offerAmount2: "$72,000" })), null);
  assert.equal(creditDqReason(withCredit({ minOfferAmount: 10000 }), report({ offerAmount1: null })), "credit:min_offer");
  assert.equal(creditDqReason(withCredit({ minIncome: 50000 }), report({ income: 40000 })), "credit:min_income");
  assert.equal(creditDqReason(withCredit({ minIncome: 50000 }), report({ income: null })), null);
  assert.equal(creditDqReason(withCredit({ creditFreeze: true }), report({ creditFreeze: "Yes" })), "credit:freeze");
  assert.equal(creditDqReason(withCredit({ creditFreeze: true }), report({ creditFreeze: "No" })), null);
});

test("creditDqReason: a report with no score is only turned away by the no-file switch", () => {
  assert.equal(creditDqReason(withCredit({ minScore: 620, minOfferAmount: 10000 }), report({ score: null, offerAmount1: null })), null);
  assert.equal(creditDqReason(withCredit({ noScore: true }), report({ score: null })), "credit:no_score");
  assert.equal(creditDqReason(DEFAULT_RULES, report({ score: 300, offerAmount1: null, income: 0 })), null);
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

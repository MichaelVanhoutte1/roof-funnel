import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, leadOutcome, offerBand, resultLabel, scoreBand, sourceLabel, type ReportLead } from "../src/report.ts";

const NOW = "2026-11-10T00:00:00.000Z";
const lead = (over: Partial<ReportLead> = {}): ReportLead => ({
  status: "full", route: "calendar", dq_reason: null, timeline: "Right away", business_owner: "I own a business",
  capital: "Yes, I will use financing.", tracking: null, appointment_id: null, appointment_start: null, pipeline_stage: null,
  opportunity_status: null, opportunity_value: null, setter_calls: null, setter_call_seconds: null, closer_appointment_id: null,
  closer_start: null, closer_status: null, closer_attended: null, credit_status: null, credit_score: null,
  credit_offer_amount_1: null, credit_offer_amount_2: null, ...over,
});
const booked = (over: Partial<ReportLead> = {}): ReportLead => lead({ appointment_id: "a1", appointment_start: "2026-11-01T15:00:00.000Z", ...over });

test("setter show comes from a long call or from the pipeline having moved past the setter", () => {
  assert.equal(leadOutcome(booked({ setter_calls: 2, setter_call_seconds: 364, pipeline_stage: "Setter Booked" }), NOW).setterShowed, true);
  assert.equal(leadOutcome(booked({ setter_calls: 1, setter_call_seconds: 119, pipeline_stage: "Setter Booked" }), NOW).setterShowed, false);
  // a quick disqualification on a short call: the stage is the witness
  assert.equal(leadOutcome(booked({ setter_calls: 1, setter_call_seconds: 51, pipeline_stage: "Setter Disqualified" }), NOW).setterShowed, true);
  assert.equal(leadOutcome(booked({ pipeline_stage: "closer followup" }), NOW).setterShowed, true);
  // not booked through the funnel: counted as talked-to stages, never as a show
  assert.equal(leadOutcome(lead({ setter_call_seconds: 600, pipeline_stage: "Closer Booked" }), NOW).setterShowed, false);
});

test("setter no-show needs a past call with no conversation and either the stage or call attempts", () => {
  assert.equal(leadOutcome(booked({ pipeline_stage: "Setter Noshow" }), NOW).setterNoShow, true);
  assert.equal(leadOutcome(booked({ setter_calls: 3, setter_call_seconds: 17, pipeline_stage: "Setter Booked" }), NOW).setterNoShow, true);
  // nothing known yet: neither showed nor no-show
  const pending = leadOutcome(booked({ pipeline_stage: "Setter Booked" }), NOW);
  assert.deepEqual([pending.setterShowed, pending.setterNoShow], [false, false]);
  // the call is still in the future
  assert.equal(leadOutcome(booked({ appointment_start: "2026-11-12T15:00:00.000Z", setter_calls: 1, setter_call_seconds: 5 }), NOW).setterNoShow, false);
  // the call started 10 minutes ago and may still be going: not a no-show until half an hour has passed
  assert.equal(leadOutcome(booked({ appointment_start: "2026-11-09T23:50:00.000Z", setter_calls: 1, setter_call_seconds: 5 }), NOW).setterNoShow, false);
  assert.equal(leadOutcome(booked({ appointment_start: "2026-11-09T23:29:00.000Z", setter_calls: 1, setter_call_seconds: 5 }), NOW).setterNoShow, true);
  // the stage says no-show but a long call exists: the call wins
  const o = leadOutcome(booked({ pipeline_stage: "Setter Noshow", setter_calls: 2, setter_call_seconds: 300 }), NOW);
  assert.deepEqual([o.setterShowed, o.setterNoShow], [true, false]);
});

test("closer attendance from Fathom / Meet beats the pipeline stage; the stage is the fallback", () => {
  assert.deepEqual(pick(leadOutcome(lead({ pipeline_stage: "Closer Followup" }), NOW)), { toCloser: true, closerShowed: true, closerNoShow: false });
  assert.deepEqual(pick(leadOutcome(lead({ pipeline_stage: "Closer Booked Noshow" }), NOW)), { toCloser: true, closerShowed: false, closerNoShow: true });
  assert.deepEqual(pick(leadOutcome(lead({ pipeline_stage: "Closer Booked", closer_attended: "showed" }), NOW)), { toCloser: true, closerShowed: true, closerNoShow: false });
  assert.deepEqual(pick(leadOutcome(lead({ pipeline_stage: "Closer Followup", closer_attended: "no_show" }), NOW)), { toCloser: true, closerShowed: false, closerNoShow: true });
  assert.deepEqual(pick(leadOutcome(lead({ pipeline_stage: "Setter Booked", closer_appointment_id: "c1" }), NOW)), { toCloser: true, closerShowed: false, closerNoShow: false });
  assert.deepEqual(pick(leadOutcome(lead({ pipeline_stage: "Closer Booked" }), NOW)), { toCloser: true, closerShowed: false, closerNoShow: false });
});
function pick(o: ReturnType<typeof leadOutcome>) { return { toCloser: o.toCloser, closerShowed: o.closerShowed, closerNoShow: o.closerNoShow }; }

test("closer booked = a closer appointment or a stage from Closer Booked onwards; Setter Qualified alone is not booked", () => {
  assert.equal(leadOutcome(lead({ pipeline_stage: "Setter Qualified" }), NOW).closerBooked, false);
  assert.equal(leadOutcome(lead({ pipeline_stage: "Setter Qualified" }), NOW).toCloser, true);
  assert.equal(leadOutcome(lead({ pipeline_stage: "Setter Qualified", closer_appointment_id: "c1" }), NOW).closerBooked, true);
  assert.equal(leadOutcome(lead({ pipeline_stage: "Closer Booked" }), NOW).closerBooked, true);
  assert.equal(leadOutcome(lead({ pipeline_stage: "Closer Booked Noshow" }), NOW).closerBooked, true);
  assert.equal(leadOutcome(lead({ pipeline_stage: "Won" }), NOW).closerBooked, true);
});

test("won counts cash from the opportunity, by stage or by opportunity status", () => {
  const a = leadOutcome(lead({ pipeline_stage: "Won", opportunity_value: 20500 }), NOW);
  assert.deepEqual([a.won, a.cash, a.closerShowed, a.toCloser], [true, 20500, true, true]);
  const b = leadOutcome(lead({ pipeline_stage: "Closer Followup", opportunity_status: "won", opportunity_value: null, closer_attended: "no_show" }), NOW);
  assert.deepEqual([b.won, b.cash, b.closerShowed, b.closerNoShow], [true, 0, true, false]);
  assert.equal(leadOutcome(lead({ pipeline_stage: "Closer Followup", opportunity_value: 9999 }), NOW).cash, 0);
});

test("bands and labels", () => {
  assert.equal(scoreBand({ credit_status: null, credit_score: null }), "Not checked");
  assert.equal(scoreBand({ credit_status: "success", credit_score: null }), "No credit file");
  assert.deepEqual([579, 580, 619, 620, 660, 699, 700].map((s) => scoreBand({ credit_status: "success", credit_score: s })),
    ["Under 580", "580–619", "580–619", "620–659", "660–699", "660–699", "700+"]);
  assert.equal(offerBand({ credit_status: "success", credit_offer_amount_1: "$1,000", credit_offer_amount_2: null }), "Under $5,000");
  assert.equal(offerBand({ credit_status: "success", credit_offer_amount_1: "$25,000", credit_offer_amount_2: "$72,000" }), "$20,000+");
  assert.equal(offerBand({ credit_status: "success", credit_offer_amount_1: null, credit_offer_amount_2: null }), "No financing offered");
  assert.equal(offerBand({ credit_status: "skipped", credit_offer_amount_1: null, credit_offer_amount_2: null }), "Not checked");
  assert.equal(sourceLabel({ tracking: JSON.stringify({ utm_source: "fb" }) }), "Facebook");
  assert.equal(sourceLabel({ tracking: JSON.stringify({ utm_source: "newsletter" }) }), "newsletter");
  assert.equal(sourceLabel({ tracking: "not json" }), "(no source)");
  assert.equal(resultLabel({ status: "partial", route: null, dq_reason: null }), "Did not finish the survey");
  assert.equal(resultLabel({ status: "full", route: "dq", dq_reason: "credit:min_score" }), "Disqualified: credit score");
  assert.equal(resultLabel({ status: "full", route: "dq", dq_reason: null }), "Disqualified");
});

test("buildReport totals, rates and per-answer rows", () => {
  const leads: ReportLead[] = [
    booked({ setter_call_seconds: 400, setter_calls: 1, pipeline_stage: "Won", opportunity_value: 20000 }),
    booked({ setter_call_seconds: 300, setter_calls: 2, pipeline_stage: "Closer Booked Noshow" }),
    booked({ pipeline_stage: "Setter Noshow", timeline: "Within 30 days" }),
    booked({ pipeline_stage: "Setter Disqualified", setter_call_seconds: 40, setter_calls: 1, timeline: "Within 30 days" }),
    lead({ timeline: "Within 30 days" }),
    lead({ status: "full", route: "dq", dq_reason: "answer:capital", capital: "No, I do not qualify to book a call." }),
    lead({ status: "partial", route: null, timeline: null, capital: null, business_owner: null, pipeline_stage: "Mystery Stage" }),
  ];
  const r = buildReport(leads, NOW);
  const t = r.totals;
  assert.deepEqual(
    [t.leads, t.qualified, t.booked, t.showed, t.noShow, t.setterDq, t.toCloser, t.closerBooked, t.closerShowed, t.closerNoShow, t.won, t.cash],
    [7, 5, 4, 3, 1, 1, 2, 2, 1, 1, 1, 20000],
  );
  assert.equal(t.bookRate, 4 / 7);
  assert.equal(t.showRate, 3 / 4);
  assert.equal(t.closerBookRate, 2 / 3);
  assert.equal(t.closerShowRate, 1 / 2);
  assert.equal(t.closeRate, 1);
  assert.equal(t.cashPerBooked, 5000);
  assert.deepEqual(r.unknownStages, ["Mystery Stage"]);
  const timeline = r.segments.find((s) => s.key === "timeline")!;
  assert.deepEqual(timeline.rows.map((x) => [x.label, x.leads, x.booked]), [["Right away", 3, 2], ["Within 30 days", 3, 2], ["(not answered)", 1, 0]]);
  const within = timeline.rows[1];
  assert.deepEqual([within.showed, within.noShow, within.showRate, within.closeRate, within.cashPerBooked], [1, 1, 0.5, null, 0]);
  assert.deepEqual(r.segments.map((s) => s.key), ["capital", "timeline", "business_owner", "credit_score", "credit_offer", "result", "source", "device"]);
  const empty = buildReport([], NOW).totals;
  assert.deepEqual([empty.leads, empty.bookRate, empty.showRate, empty.closeRate, empty.cashPerBooked], [0, null, null, null, null]);
});

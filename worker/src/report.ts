/**
 * Lead tracking report for the admin page: book / show / close rates per qualification answer,
 * credit band, ad source and device. Pure functions over lead rows, so they are unit tested.
 *
 * How a lead moves: the funnel books a 15-minute SETTER phone call; a lead the setter qualifies gets a
 * CLOSER call on Google Meet; "Won" in the GHL Sales Pipeline is a close.
 *
 * Where each outcome comes from:
 *  - setter show / no-show: the GHL call log (a completed call of SHOW_MIN_CALL_SECONDS or more), with the
 *    pipeline stage as a second witness (a lead moved past the setter obviously talked to the setter);
 *  - closer show / no-show: Fathom or Google Meet attendance when connected, else the pipeline stage;
 *  - setter disqualified, passed to closer, won and cash: the pipeline stage and opportunity value.
 */
import { parseMoney } from "./rules.ts";

/** Measured on 99 past booked leads (2026-11-09): every lead moved past the setter had a call >= 120 s, no no-show did. */
export const SHOW_MIN_CALL_SECONDS = 120;
const NO_SHOW_GRACE_MS = 30 * 60_000;

export type ReportLead = {
  status: string;
  route: string | null;
  dq_reason: string | null;
  timeline: string | null;
  business_owner: string | null;
  capital: string | null;
  tracking: string | null;
  appointment_id: string | null;
  appointment_start: string | null;
  /** GHL appointment status of the setter call (confirmed, showed, noshow, cancelled, ...). */
  appointment_status: string | null;
  pipeline_stage: string | null;
  opportunity_status: string | null;
  opportunity_value: number | null;
  setter_calls: number | null;
  setter_call_seconds: number | null;
  closer_appointment_id: string | null;
  closer_start: string | null;
  closer_status: string | null;
  closer_attended: string | null;
  credit_status: string | null;
  credit_score: number | null;
  credit_offer_amount_1: string | null;
  credit_offer_amount_2: string | null;
  /** Set by hand on the Appointments page; null/absent = automatic. These win over every other witness. */
  setter_attended_manual?: string | null;
  closer_attended_manual?: string | null;
  /** 1 = closed (cash_manual is the amount), 0 = did not close even if GHL says Won, null = follow GHL. */
  won_manual?: number | null;
  cash_manual?: number | null;
  close_date_manual?: string | null;
};

type StageFacts = { talked: boolean; setterNoShow: boolean; setterDq: boolean; toCloser: boolean; closerBooked: boolean; closerShowed: boolean; closerNoShow: boolean; won: boolean };

const NO: StageFacts = { talked: false, setterNoShow: false, setterDq: false, toCloser: false, closerBooked: false, closerShowed: false, closerNoShow: false, won: false };

/** Pipeline stage name (as written in GHL, case-insensitive) → what it says about the lead. */
const STAGE_FACTS: Record<string, StageFacts> = {
  "new lead": NO,
  "setter booked": NO,
  "setter noshow": { ...NO, setterNoShow: true },
  "setter disqualified": { ...NO, talked: true, setterDq: true },
  "setter qualified": { ...NO, talked: true, toCloser: true },
  "closer booked": { ...NO, talked: true, toCloser: true, closerBooked: true },
  "closer followup": { ...NO, talked: true, toCloser: true, closerBooked: true, closerShowed: true },
  "closer booked noshow": { ...NO, talked: true, toCloser: true, closerBooked: true, closerNoShow: true },
  won: { ...NO, talked: true, toCloser: true, closerBooked: true, closerShowed: true, won: true },
};

export function knownStage(stage: string | null | undefined): boolean {
  return !!stage && stage.trim().toLowerCase() in STAGE_FACTS;
}

export type Outcome = {
  booked: boolean;
  setterShowed: boolean;
  setterNoShow: boolean;
  setterDq: boolean;
  /** Passed the setter (Setter Qualified or further), whether or not a closer call is on the calendar yet. */
  toCloser: boolean;
  /** A closer call is booked: a closer calendar appointment, or a stage from Closer Booked onwards. */
  closerBooked: boolean;
  closerShowed: boolean;
  closerNoShow: boolean;
  won: boolean;
  cash: number;
  /**
   * Booked calls without a show / no-show yet, so that showed + noShow + pending + cancelled + upcoming = booked:
   * upcoming = still ahead (or started under half an hour ago); cancelled = cancelled in GHL;
   * pending = past, and no witness said anything (no call log, card not moved, no status, no Meet record yet).
   */
  setterUpcoming: boolean;
  setterCancelled: boolean;
  setterPending: boolean;
  closerUpcoming: boolean;
  closerCancelled: boolean;
  closerPending: boolean;
};

/** Everything the report counts for one lead, as of `nowIso`. */
export function leadOutcome(l: ReportLead, nowIso: string): Outcome {
  const stage = STAGE_FACTS[(l.pipeline_stage ?? "").trim().toLowerCase()] ?? NO;
  // Hand-set outcomes (Appointments page) win over everything below.
  const manualSetter = l.setter_attended_manual ?? null, manualCloser = l.closer_attended_manual ?? null;
  const won = l.won_manual === 1 ? true : l.won_manual === 0 ? false : stage.won || l.opportunity_status === "won";
  const booked = !!l.appointment_id;
  // A call counts as missed half an hour after its start, so a call in progress is not a no-show.
  const past = !!l.appointment_start && Date.parse(l.appointment_start) + NO_SHOW_GRACE_MS <= Date.parse(nowIso);
  const longCall = (l.setter_call_seconds ?? 0) >= SHOW_MIN_CALL_SECONDS;
  // The GHL appointment status is a third witness when the setter marks the call by hand.
  const ghlSetter = (l.appointment_status ?? "").toLowerCase();
  const talked = manualSetter === "showed" || (manualSetter !== "no_show" && (longCall || stage.talked || won || ghlSetter === "showed"));
  // A past booked call with no conversation is a no-show once the setter marked it or tried calling.
  const setterNoShow = manualSetter === "no_show" ? booked : booked && past && !talked && (stage.setterNoShow || ghlSetter === "noshow" || (l.setter_calls ?? 0) > 0);
  const toCloser = stage.toCloser || won || !!l.closer_appointment_id;
  const closerBooked = stage.closerBooked || won || !!l.closer_appointment_id;
  const ghlCloser = (l.closer_status ?? "").toLowerCase();
  // Any positive witness wins: a Meet/Fathom record of the prospect, a card moved to Followup/Won, or a hand-set
  // GHL status. A Meet "no_show" alone does not overrule a card a human moved past the call (seen live: a Closer
  // Followup lead whose call happened off-Meet), it only decides when nobody recorded a show.
  const closerShowed = manualCloser === "showed" || (manualCloser !== "no_show" && (won || l.closer_attended === "showed" || stage.closerShowed || ghlCloser === "showed"));
  const closerNoShow = manualCloser === "no_show" ? closerBooked : !closerShowed && (l.closer_attended === "no_show" || stage.closerNoShow || ghlCloser === "noshow");
  // Booked calls with no outcome yet, split so the counts always add up to booked.
  const setterShowed = booked && talked;
  const setterOpen = booked && !setterShowed && !setterNoShow;
  const setterCancelled = setterOpen && ghlSetter === "cancelled";
  const setterUpcoming = setterOpen && !setterCancelled && !!l.appointment_start && !past;
  const closerPast = !!l.closer_start && Date.parse(l.closer_start) + NO_SHOW_GRACE_MS <= Date.parse(nowIso);
  const closerOpen = closerBooked && !closerShowed && !closerNoShow;
  const closerCancelled = closerOpen && ghlCloser === "cancelled";
  const closerUpcoming = closerOpen && !closerCancelled && !!l.closer_start && !closerPast;
  return {
    booked,
    setterShowed,
    setterNoShow,
    setterDq: stage.setterDq,
    toCloser,
    closerBooked,
    closerShowed,
    closerNoShow,
    won,
    cash: won ? l.cash_manual ?? l.opportunity_value ?? 0 : 0,
    setterUpcoming,
    setterCancelled,
    setterPending: setterOpen && !setterCancelled && !setterUpcoming,
    closerUpcoming,
    closerCancelled,
    closerPending: closerOpen && !closerCancelled && !closerUpcoming,
  };
}

export type SegmentRow = {
  label: string;
  leads: number;
  /** Completed the survey and was sent to the calendar. */
  qualified: number;
  booked: number;
  /** booked ÷ leads */
  bookRate: number | null;
  /** Booked and had the setter conversation. */
  showed: number;
  noShow: number;
  /** showed ÷ (showed + noShow) */
  showRate: number | null;
  /** Booked setter calls with no outcome yet: still ahead / cancelled in GHL / past with no witness. */
  upcoming: number;
  cancelled: number;
  pending: number;
  setterDq: number;
  toCloser: number;
  closerBooked: number;
  /** closerBooked ÷ showed (setter showed) */
  closerBookRate: number | null;
  closerShowed: number;
  closerNoShow: number;
  /** closerShowed ÷ (closerShowed + closerNoShow) */
  closerShowRate: number | null;
  /** Booked closer calls with no outcome yet: still ahead / cancelled in GHL / past with no witness. */
  closerUpcoming: number;
  closerCancelled: number;
  closerPending: number;
  won: number;
  /** won ÷ closerShowed */
  closeRate: number | null;
  cash: number;
  /** cash ÷ booked */
  cashPerBooked: number | null;
};

type Counts = Omit<SegmentRow, "bookRate" | "showRate" | "closerBookRate" | "closerShowRate" | "closeRate" | "cashPerBooked">;

function emptyCounts(label: string): Counts {
  return {
    label, leads: 0, qualified: 0, booked: 0, showed: 0, noShow: 0, upcoming: 0, cancelled: 0, pending: 0, setterDq: 0, toCloser: 0,
    closerBooked: 0, closerShowed: 0, closerNoShow: 0, closerUpcoming: 0, closerCancelled: 0, closerPending: 0, won: 0, cash: 0,
  };
}

function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

function finish(c: Counts): SegmentRow {
  return {
    ...c,
    bookRate: rate(c.booked, c.leads),
    showRate: rate(c.showed, c.showed + c.noShow),
    closerBookRate: rate(c.closerBooked, c.showed),
    closerShowRate: rate(c.closerShowed, c.closerShowed + c.closerNoShow),
    closeRate: rate(c.won, c.closerShowed),
    cashPerBooked: c.booked > 0 ? c.cash / c.booked : null,
  };
}

function add(c: Counts, l: ReportLead, o: Outcome): void {
  c.leads++;
  if (l.status === "full" && l.route === "calendar") c.qualified++;
  if (o.booked) c.booked++;
  if (o.setterShowed) c.showed++;
  if (o.setterNoShow) c.noShow++;
  if (o.setterUpcoming) c.upcoming++;
  if (o.setterCancelled) c.cancelled++;
  if (o.setterPending) c.pending++;
  if (o.setterDq) c.setterDq++;
  if (o.toCloser) c.toCloser++;
  if (o.closerBooked) c.closerBooked++;
  if (o.closerShowed) c.closerShowed++;
  if (o.closerNoShow) c.closerNoShow++;
  if (o.closerUpcoming) c.closerUpcoming++;
  if (o.closerCancelled) c.closerCancelled++;
  if (o.closerPending) c.closerPending++;
  if (o.won) c.won++;
  c.cash += o.cash;
}

/* ---------------- segment keys ---------------- */

const NOT_ANSWERED = "(not answered)";

export function scoreBand(l: Pick<ReportLead, "credit_status" | "credit_score">): string {
  if (l.credit_status !== "success") return "Not checked";
  const s = l.credit_score;
  if (s === null) return "No credit file";
  if (s < 580) return "Under 580";
  if (s < 620) return "580–619";
  if (s < 660) return "620–659";
  if (s < 700) return "660–699";
  return "700+";
}

export function offerBand(l: Pick<ReportLead, "credit_status" | "credit_offer_amount_1" | "credit_offer_amount_2">): string {
  if (l.credit_status !== "success") return "Not checked";
  const amounts = [parseMoney(l.credit_offer_amount_1), parseMoney(l.credit_offer_amount_2)].filter((n): n is number => n !== null);
  if (!amounts.length) return "No financing offered";
  const a = Math.max(...amounts);
  if (a < 5_000) return "Under $5,000";
  if (a < 10_000) return "$5,000–$9,999";
  if (a < 20_000) return "$10,000–$19,999";
  return "$20,000+";
}

function trackingField(l: Pick<ReportLead, "tracking">, key: string): string | null {
  if (!l.tracking) return null;
  try {
    const v = (JSON.parse(l.tracking) as Record<string, unknown>)[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

const SOURCES: Record<string, string> = { fb: "Facebook", facebook: "Facebook", ig: "Instagram", instagram: "Instagram", an: "Audience Network", google: "Google" };

export function sourceLabel(l: Pick<ReportLead, "tracking">): string {
  const raw = trackingField(l, "utm_source");
  if (!raw) return "(no source)";
  return SOURCES[raw.toLowerCase()] ?? raw;
}

const DQ_LABELS: Record<string, string> = {
  "answer:capital": "Disqualified: capital answer",
  "answer:timeline": "Disqualified: timeline answer",
  "answer:business_owner": "Disqualified: business owner answer",
  "credit:min_score": "Disqualified: credit score",
  "credit:min_offer": "Disqualified: financing amount",
  "credit:min_income": "Disqualified: income",
  "credit:no_score": "Disqualified: no credit file",
  "credit:freeze": "Disqualified: credit freeze",
};

export function resultLabel(l: Pick<ReportLead, "status" | "route" | "dq_reason">): string {
  if (l.status !== "full") return "Did not finish the survey";
  if (l.route === "calendar") return "Sent to the calendar";
  return DQ_LABELS[l.dq_reason ?? ""] ?? "Disqualified";
}

type SegmentDef = { key: string; title: string; of: (l: ReportLead) => string; order?: readonly string[] };

const SEGMENTS: SegmentDef[] = [
  { key: "capital", title: "$20,000 in accessible capital?", of: (l) => l.capital ?? NOT_ANSWERED },
  { key: "timeline", title: "How soon are you planning to become a dealer?", of: (l) => l.timeline ?? NOT_ANSWERED, order: ["Right away", "Within 30 days", "More than 30 days"] },
  { key: "business_owner", title: "Business owner, or looking to start one?", of: (l) => l.business_owner ?? NOT_ANSWERED },
  { key: "credit_score", title: "Credit score", of: scoreBand, order: ["700+", "660–699", "620–659", "580–619", "Under 580", "No credit file", "Not checked"] },
  { key: "credit_offer", title: "Financing offered", of: offerBand, order: ["$20,000+", "$10,000–$19,999", "$5,000–$9,999", "Under $5,000", "No financing offered", "Not checked"] },
  { key: "result", title: "What the funnel did", of: resultLabel },
  { key: "source", title: "Ad source", of: sourceLabel },
  { key: "device", title: "Device", of: (l) => trackingField(l, "device_type") ?? "(unknown)" },
];

export type Report = {
  totals: SegmentRow;
  segments: Array<{ key: string; title: string; rows: SegmentRow[] }>;
  /** Pipeline stage names found on leads that this report does not understand (renamed or new stages in GHL). */
  unknownStages: string[];
  showMinCallSeconds: number;
};

export function buildReport(leads: ReportLead[], nowIso: string): Report {
  const totals = emptyCounts("All leads");
  const unknown = new Set<string>();
  const outcomes = leads.map((l) => leadOutcome(l, nowIso));
  leads.forEach((l, i) => {
    add(totals, l, outcomes[i]);
    if (l.pipeline_stage && !knownStage(l.pipeline_stage)) unknown.add(l.pipeline_stage);
  });
  const segments = SEGMENTS.map((def) => {
    const byLabel = new Map<string, Counts>();
    leads.forEach((l, i) => {
      const label = def.of(l);
      let c = byLabel.get(label);
      if (!c) byLabel.set(label, (c = emptyCounts(label)));
      add(c, l, outcomes[i]);
    });
    const rows = [...byLabel.values()].sort((a, b) => {
      if (def.order) {
        const ia = def.order.indexOf(a.label), ib = def.order.indexOf(b.label);
        if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      }
      if ((a.label === NOT_ANSWERED) !== (b.label === NOT_ANSWERED)) return a.label === NOT_ANSWERED ? 1 : -1;
      return b.leads - a.leads || a.label.localeCompare(b.label);
    });
    return { key: def.key, title: def.title, rows: rows.map(finish) };
  });
  return { totals: finish(totals), segments, unknownStages: [...unknown].sort(), showMinCallSeconds: SHOW_MIN_CALL_SECONDS };
}

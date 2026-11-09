/** #lead-alerts message for a qualified lead, so a setter can dial right away. */
export type AlertLead = {
  id: number; name?: string | null; phone: string; email?: string | null; city?: string | null;
  timeline?: string | null; business_owner?: string | null; capital?: string | null;
  partial: boolean; source?: string | null; campaign?: string | null;
};

function prettyPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function leadAlertMessage(l: AlertLead): Record<string, unknown> {
  const name = l.name?.trim() || "Unknown name";
  const phone = prettyPhone(l.phone);
  const status = l.partial ? "⚠️ Left after entering phone — call now" : "✅ Completed the application";
  const lines = [
    ["How soon", l.timeline], ["Business owner", l.business_owner], ["$20K capital", l.capital], ["City", l.city],
  ].filter(([, v]) => v).map(([k, v]) => `*${k}:* ${esc(String(v))}`).join("\n");
  const src = [l.source, l.campaign].filter(Boolean).join(" · ");
  return {
    text: `New qualified lead: ${name} ${phone}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `🔥 New qualified lead: ${name}`.slice(0, 150) } },
      { type: "section", fields: [
        { type: "mrkdwn", text: `*Phone*\n<tel:${l.phone}|${phone}>` },
        { type: "mrkdwn", text: `*Email*\n${l.email ? esc(l.email) : "—"}` },
      ] },
      { type: "section", text: { type: "mrkdwn", text: lines || "_No answers captured_" } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${status}  ·  lead #${l.id}${src ? `  ·  ${esc(src)}` : ""}` }] },
    ],
  };
}

/** Follow-up to the lead alert once the soft credit check has answered. */
export type CreditAlert = {
  id: number; name?: string | null; score: number | null; offerStatus: string | null; offerAmount: string | null;
  dti: number | null; income: number | null; creditFreeze: string | null;
};

export function creditAlertMessage(c: CreditAlert): Record<string, unknown> {
  const name = c.name?.trim() || "Unknown name";
  const facts = [
    c.score != null ? `*Score:* ${c.score}` : "*Score:* no credit file matched",
    c.offerStatus ? `*Financing:* ${esc(c.offerStatus)}${c.offerAmount ? ` (${esc(c.offerAmount)})` : ""}` : null,
    c.dti != null ? `*Debt-to-income:* ${c.dti}%` : null,
    c.income != null ? `*Est. income:* $${Math.round(c.income).toLocaleString("en-US")}` : null,
    c.creditFreeze && /^y/i.test(c.creditFreeze) ? "*Credit freeze:* Yes" : null,
  ].filter((f): f is string => !!f).join("  ·  ");
  return {
    text: `Credit check: ${name}${c.score != null ? ` — ${c.score}` : ""}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `💳 *Credit check: ${esc(name)}*\n${facts}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Soft pull, no score impact  ·  lead #${c.id}` }] },
    ],
  };
}

/** One-off notice that soft credit checks are not running (paused account, rejected token, cap reached). */
export function creditProblemMessage(reason: string): Record<string, unknown> {
  return {
    text: `Credit checks are not running: ${reason}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `⚠️ *Credit checks are not running*\n${esc(reason)}. Leads are still captured and booked as usual.` } },
    ],
  };
}

/** The lead was alerted (from the partial save) and then did not pass the credit rules on submit. */
export function leadWithdrawnMessage(l: { id: number; name?: string | null }): Record<string, unknown> {
  const name = l.name?.trim() || "Unknown name";
  return {
    text: `Not qualified after all: ${name}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `↩️ *${esc(name)}* did not pass the credit rules and was not offered a call.` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `lead #${l.id}` }] },
    ],
  };
}

export async function postSlack(webhookUrl: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

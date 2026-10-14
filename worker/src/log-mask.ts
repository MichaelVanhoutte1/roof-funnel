/** PII masks for logs: trace a submission without reproducing contact details. */
export function maskPhone(phone: unknown): string {
  if (typeof phone !== "string" || !phone) return "(none)";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : "(short)";
}
export function maskName(name: unknown): string {
  const t = typeof name === "string" ? name.trim() : "";
  if (!t) return "(none)";
  const parts = t.split(/\s+/);
  const last = parts.length > 1 ? ` ${parts[parts.length - 1]?.[0] ?? ""}.` : "";
  return `${parts[0]}${last}`;
}
export function maskEmail(email: unknown): string {
  if (typeof email !== "string" || !email.includes("@")) return "(none)";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}…@${domain}`;
}

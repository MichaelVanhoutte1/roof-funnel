/**
 * Lead gating for POST /lead and POST /lead/partial.
 * Ported from the Stone Systems funnel (optin-validation + fake-lead-heuristics) with the
 * OnYa Roof survey questions. Three outcomes: reject (400 + message), ghost (200 silent,
 * nothing reaches the CRM), process.
 */
import parsePhoneNumberFromString, { type CountryCode, type PhoneNumber } from "libphonenumber-js";

const US_CANADA_COUNTRIES = new Set<CountryCode>(["US", "CA", "PR", "VI", "GU", "MP", "AS"]);

export const TIMELINE_OPTIONS = ["Right Away!", "Within 30 Days", "More Than 30 Days"] as const;
export const BUSINESS_OWNER_OPTIONS = ["I own a business", "I want to start one"] as const;
export const CAPITAL_OPTIONS = [
  "Yes - I have $20,000+ available right now",
  "Yes - I will use financing",
  "No - I do not qualify to book a call",
] as const;
/** The one answer that routes to "not a fit" instead of the calendar. */
export const CAPITAL_DQ_VALUE: (typeof CAPITAL_OPTIONS)[number] = "No - I do not qualify to book a call";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value: string | undefined): value is string {
  if (!value) return false;
  const t = value.trim();
  return t.length <= 254 && EMAIL_RE.test(t);
}

/** Digits as typed, minus a single leading country-code 1 on an 11-digit number. Never truncates. */
export function nationalDigitsFromPhoneInput(value: string): string {
  const d = value.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
}

function parseUsCanadaPhone(phone: string | undefined): PhoneNumber | null {
  if (!phone || typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const parsed =
    digits.length === 10 ? parsePhoneNumberFromString(`+1${digits}`) : parsePhoneNumberFromString(`+${digits}`);
  if (!parsed?.isValid()) return null;
  if (parsed.countryCallingCode !== "1") return null;
  if (!parsed.country || !US_CANADA_COUNTRIES.has(parsed.country)) return null;
  return parsed;
}

/** E.164 for a real US/CA number; toll-free and premium rejected. */
export function usCanadaE164(phone: string | undefined): string | null {
  const parsed = parseUsCanadaPhone(phone);
  if (!parsed) return null;
  const type = parsed.getType();
  if (type === "TOLL_FREE" || type === "PREMIUM_RATE") return null;
  return parsed.number;
}

export function normalizePhoneDigits10(phone: string | undefined): string | null {
  const e164 = usCanadaE164(phone);
  return e164 ? e164.replace(/\D/g, "").slice(-10) : null;
}

export function isObviousFakePhone10(digits10: string): boolean {
  if (digits10.length !== 10) return true;
  const d = digits10.split("").map(Number);
  if (d.every((x) => x === d[0])) return true;
  let asc = true, desc = true;
  for (let i = 1; i < 10; i++) {
    if (d[i] !== d[i - 1] + 1) asc = false;
    if (d[i] !== d[i - 1] - 1) desc = false;
  }
  if (asc || desc) return true;
  if (d[0] !== d[1] && digits10 === `${d[0]}${d[1]}`.repeat(5)) return true;
  if (digits10.slice(0, 3) === "555" && digits10.slice(3, 6).startsWith("01")) return true;
  return false;
}

const JUNK_NAME_REGEX =
  /^(test|testing|asdf|qwerty|qwertyuiop|none|n\/a|na|null|undefined|xxx|foo|bar|abc|sample|fake|user|name|firstname|lastname)$/i;

function lettersOnly(s: string): string {
  return s.replace(/[^a-zA-Z]/g, "");
}

const KEYBOARD_MASH_RUNS = [
  "qwert", "werty", "ertyu", "rtyui", "tyuio", "yuiop",
  "asdfg", "sdfgh", "dfghj", "fghjk", "ghjkl",
  "zxcvb", "xcvbn", "cvbnm",
  "qazws", "wsxed", "edcrf", "rfvtg", "tgbyh",
  "poiuy", "oiuyt", "lkjhg", "kjhgf", "mnbvc", "nbvcx",
] as const;

function hasKeyboardMash(value: string): boolean {
  const lower = value.toLowerCase();
  return KEYBOARD_MASH_RUNS.some((run) => lower.includes(run));
}

const VOWELS_RE = /[aeiouy]/i;

function isGibberishLetters(letters: string): boolean {
  if (letters.length >= 5 && !VOWELS_RE.test(letters)) return true;
  if (/[bcdfghjklmnpqrstvwxz]{7,}/i.test(letters)) return true;
  if (letters.length >= 8) {
    const vowelCount = (letters.match(/[aeiouy]/gi) ?? []).length;
    if (vowelCount / letters.length < 0.15) return true;
  }
  return false;
}

/** Name or city: obvious junk (ghost path, never a user-facing error). */
export function isObviousFakeText(value: string | undefined): boolean {
  const t = value?.trim() ?? "";
  if (t.length < 2) return true;
  if (/^\d+$/.test(t)) return true;
  if (JUNK_NAME_REGEX.test(t)) return true;
  if (hasKeyboardMash(t)) return true;
  const letters = lettersOnly(t);
  if (letters.length >= 4 && /^(.)\1+$/.test(letters.toLowerCase())) return true;
  const words = t.split(/[^a-zA-Z]+/).filter((w) => w.length >= 4);
  if (words.length > 0 && words.every((w) => isGibberishLetters(w))) return true;
  return false;
}

const FAKE_EMAIL_DOMAINS = new Set([
  "example.com", "example.org", "example.net",
  "test.com", "fake.com", "fakeemail.com", "fakemail.com", "asdf.com",
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com",
  "10minutemail.com", "temp-mail.org", "tempmail.com", "tempmail.net",
  "tempmailo.com", "throwawaymail.com", "trashmail.com", "trashmail.net",
  "yopmail.com", "getnada.com", "dispostable.com", "maildrop.cc",
  "mintemail.com", "fakeinbox.com", "mohmal.com", "emailondeck.com",
  "mailnesia.com", "spamgourmet.com", "mytemp.email", "burnermail.io",
]);

const JUNK_EMAIL_LOCAL_RE = /^(test|testing|fake|asdf|qwerty|abc|sample|none|null|noemail|no-?reply|spam|junk)\d*$/i;

export function isObviousFakeEmail(value: string | undefined): boolean {
  if (!isValidEmail(value)) return false;
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (FAKE_EMAIL_DOMAINS.has(domain)) return true;
  if (JUNK_EMAIL_LOCAL_RE.test(local)) return true;
  if (hasKeyboardMash(local) || hasKeyboardMash(domain)) return true;
  const localLetters = lettersOnly(local);
  if (localLetters.length >= 8 && !VOWELS_RE.test(localLetters)) return true;
  if (/^(.)\1+$/.test(localLetters) && localLetters.length >= 4) return true;
  return false;
}

/* ---------------- identity-level fake-lead heuristics (validated on 7,966 contacts; do not tune) ---------------- */

const BIGRAM_TOTAL = 89529;
const BIGRAM_PACKED = [
  "^a740|^b836|^c1187|^d710|^e328|^f315|^g528|^h468|^i133|^j1400|^k373|^l512|^m1101|^n274|^o126|^p4",
  "68|^q17|^r820|^s1030|^t582|^u166|^v324|^w450|^x5|^y53|^z86|a$666|aa54|ab94|ac504|ad269|ae142|af4",
  "3|ag84|ah105|ai134|aj20|ak117|al677|am557|an1679|ao12|ap54|aq9|ar1197|as446|at376|au174|av268|aw",
  "80|ax21|ay223|az51|b$142|ba184|bb44|bd10|be340|bg2|bh2|bi135|bj3|bk2|bl64|bm2|bn5|bo146|br368|bs",
  "117|bu94|bv2|by51|c$126|ca371|cb2|cc50|cd6|ce135|cf1|cg12|ch717|ci136|ck326|cl73|cm8|cn5|co630|c",
  "p4|cq4|cr85|cs6|ct267|cu57|cv2|cw1|cy18|cz7|d$580|da491|db5|dc5|dd61|de399|df6|dg18|dh8|di158|dj",
  "2|dk2|dl34|dm9|dn10|do302|dr179|ds54|dt10|du73|dw47|dy125|dz2|e$1324|ea166|eb160|ec67|ed234|ee14",
  "4|ef89|eg85|eh23|ei110|ej26|ek48|el777|em163|en635|eo83|ep72|eq6|er1476|es574|et229|eu20|ev198|e",
  "w122|ex74|ey243|ez312|f$84|fa64|fe78|ff105|fg2|fi71|fk1|fl43|fm3|fo73|fr134|fs4|ft11|fu14|fv1|g$",
  "160|ga255|gb3|gc2|gd5|ge239|gf1|gg30|gh103|gi81|gk1|gl40|gm1|gn12|go148|gq1|gr107|gs20|gt9|gu154",
  "|gw2|gy5|h$391|ha729|hb6|hc1|hd5|he383|hf1|hg1|hh2|hi153|hk3|hl23|hm45|hn243|ho266|hr175|hs5|ht3",
  "6|hu132|hv3|hw7|hy29|i$267|ia382|ib36|ic531|id187|ie296|if31|ig144|ih4|ii13|ij10|ik128|il437|im1",
  "89|in804|io144|ip34|iq8|ir126|is689|it462|iu18|iv46|iw2|ix10|iy5|iz46|j$9|ja470|jb1|jd1|je217|jh",
  "5|ji65|jm1|jn1|jo610|jr2|js4|ju113|jw1|k$392|ka93|kb4|ke436|kf2|kh15|ki167|kk2|kl24|km11|kn157|k",
  "o88|kp1|kr19|ks55|kt4|ku29|kw5|ky54|l$709|la503|lb62|lc39|ld117|le836|lf19|lg10|lh7|li410|lk28|l",
  "l650|lm41|ln4|lo333|lp12|lr4|ls65|lt71|lu101|lv48|lw9|lx1|ly93|lz4|m$327|ma707|mb51|mc97|me328|m",
  "f1|mg1|mh1|mi515|mk2|ml7|mm74|mn2|mo222|mp76|mr7|ms88|mt1|mu75|mv1|mw1|my82|n$2476|na341|nb31|nc",
  "127|nd480|ne492|nf13|ng201|nh11|ni319|nj14|nk228|nl14|nm6|nn208|no353|nr24|ns244|nt477|nu37|nv3|",
  "nw6|ny161|nz60|o$632|oa50|ob274|oc59|od174|oe110|of34|og55|oh259|oi24|oj12|ok26|ol271|om199|on15",
  "32|oo129|op91|oq5|or654|os386|ot137|ou146|ov61|ow264|ox12|oy59|oz32|p$42|pa211|pb5|pc2|pe208|pf1",
  "|ph137|pi64|pk4|pl34|pm7|pn2|po59|pp23|pr60|ps33|pt8|pu22|py4|q$5|qa3|qr1|qu60|r$1015|ra714|rb31",
  "|rc106|rd225|re740|rf6|rg117|rh14|ri858|rj4|rk126|rl112|rm53|rn139|ro693|rp21|rq5|rr299|rs158|rt",
  "323|ru122|rv21|rw13|rx1|ry258|rz17|s$1329|sa298|sb14|sc159|sd4|se333|sf5|sg1|sh284|si364|sj1|sk7",
  "4|sl36|sm93|sn25|so455|sp47|sq8|sr9|ss144|st634|su63|sv2|sw27|sx1|sy51|sz8|t$718|ta437|tb4|tc37|",
  "td1|te584|tf2|tg3|th424|ti348|tj1|tk10|tl32|tm13|tn14|to652|tr233|ts39|tt316|tu60|tv1|tw5|ty86|t",
  "z32|u$38|ua112|ub40|uc62|ud53|ue156|uf8|ug79|uh9|ui104|uj3|uk40|ul147|um59|un299|uo4|up20|uq2|ur",
  "163|us211|ut75|uv6|uw1|ux8|uy10|uz35|v$19|va209|vb2|vd1|ve226|vg2|vi462|vk2|vl5|vn2|vo43|vr3|vs8",
  "|vu3|vv2|vy5|w$108|wa157|wc1|wd4|we214|wf5|wh32|wi188|wk6|wl8|wm4|wn211|wo46|wr21|ws30|wt4|wy10|",
  "x$92|xa19|xb2|xe2|xi7|xm1|xo2|xp1|xt5|xw2|y$1006|ya126|yb6|yc7|yd32|ye55|yg1|yh7|yi2|yj2|yk6|yl1",
  "55|ym14|yn61|yo37|yp1|yr23|ys58|yt15|yu2|yv5|yw3|yy1|yz5|z$375|za170|zc6|zd1|ze39|zg3|zh2|zi28|z",
  "j2|zk3|zl1|zm12|zn2|zo31|zp1|zq4|zr2|zs1|zu9|zw1|zy4|zz17",
].join("");

let bigramCounts: Map<string, number> | null = null;
function getBigramCounts(): Map<string, number> {
  if (!bigramCounts) {
    bigramCounts = new Map(BIGRAM_PACKED.split("|").map((e) => [e.slice(0, 2), Number(e.slice(2))]));
  }
  return bigramCounts;
}
const BIGRAM_VSIZE = 27 * 27;

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function tokenLogLikelihood(token: string): number {
  const s = `^${token}$`;
  let ll = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const count = getBigramCounts().get(s.slice(i, i + 2)) ?? 0;
    ll += Math.log2((count + 0.5) / (BIGRAM_TOTAL + 0.5 * BIGRAM_VSIZE));
  }
  return ll / (s.length - 1);
}

function isGibberishName(value: string, threshold: number): boolean {
  const scorable = nameTokens(value).filter((t) => t.length >= 3);
  return scorable.length > 0 && scorable.every((t) => tokenLogLikelihood(t) < threshold);
}

const GIBBERISH_THRESHOLD = -11;
const GIBBERISH_THRESHOLD_BARE = -10;

const PROFANITY_RE =
  /\b(nigger|niggery|fuck\w*|bitch|deez ?nuts|butt ?sniffer|buttcheeks|drippy ?butt|poppy ?butt|dick ?balls|gay ?boy|yo ?mama|(big|bull|dog|horse)?shit\w*)\b/i;
const JOKE_NAME_RE =
  /^(john ?doe|jane ?doe|jon ?doe|joe ?mama|joemama|jon ?pork|mike ?hawk|ben ?dover|al ?pachino|gohighlevel)$/i;
const TEST_WORD_RE = /\b(test|teste|tezst|testing\w*|fake|e2e|probe|demo|dummy|notalead|funnel ?hack\w*|istesting)\b/i;
const EMAIL_TEST_TOKEN_RE = /(^|[._+-])(test\w*|fake|e2e|probe\d*|demo|dummy|notalead|iamnotalead)([._+-]|\d|$)/i;
const GENERIC_FREEMAIL_RE =
  /^(info|admin|office|sales|contact|hello|mail|email|name|noname|yes|no|swag|cool|error|idk|test)@(gmail|yahoo|hotmail|outlook|aol|icloud|gmai|gnail|gmaip|gmaail)\./i;
const ONE_LETTER_DOMAIN_RE = /@(?!q\.com$|x\.com$)[a-z0-9]\.[a-z]{2,}$/i;
const FREEMAIL_RE =
  /@(gmail|yahoo|hotmail|outlook|aol|icloud|gmai|gnail|gmaip|gmaail|ymail|live|msn|protonmail|proton|me|mac|gmx|web|mail|zoho)\./i;
const FILLER_WORDS = new Set([
  "hi", "hey", "hello", "yes", "no", "yup", "yo", "ok", "okay", "he", "she", "to",
  "me", "we", "aw", "few", "sorry", "none", "nope", "nobody", "lol", "idk", "ret",
  "etg", "boo", "zip", "poo",
]);

export type FakeLeadConfig = {
  /** Comma-separated 4–10 digit prefixes of known test numbers. */
  testPhonePrefixes?: string;
  /** Comma-separated internal email domains that only ever submit tests. */
  internalEmailDomains?: string;
};

function csv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
}

function isFakePhoneDigits10(digits10: string, cfg: FakeLeadConfig): boolean {
  if (!/^\d{10}$/.test(digits10)) return false;
  const prefixes = csv(cfg.testPhonePrefixes).filter((p) => /^\d{4,10}$/.test(p));
  if (prefixes.some((p) => digits10.startsWith(p))) return true;
  if (digits10.slice(3, 6) === "555") return true;
  if (/^(\d)\1{6}$/.test(digits10.slice(3))) return true;
  if (new Set(digits10).size <= 2) return true;
  return false;
}

function isFakeEmail(email: string, cfg: FakeLeadConfig): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  if (EMAIL_TEST_TOKEN_RE.test(local)) return true;
  const internal = csv(cfg.internalEmailDomains).filter((d) => d.includes(".") && !FREEMAIL_RE.test(`x@${d}`));
  if (internal.includes(domain)) return true;
  if (ONE_LETTER_DOMAIN_RE.test(email)) return true;
  if (GENERIC_FREEMAIL_RE.test(email)) return true;
  if (!FREEMAIL_RE.test(email)) {
    const label = domain.split(".")[0] ?? "";
    if (label.length >= 3 && label.length <= 4 && isGibberishName(label, GIBBERISH_THRESHOLD)) return true;
  }
  return false;
}

function hasPeriodicMash(name: string, email: string): boolean {
  const tokens = [...nameTokens(name), (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z]/g, "")].filter(
    (t) => t.length >= 6,
  );
  return tokens.some((t) => /^(\w{3,4})\1+\w{0,2}$/.test(t) && tokenLogLikelihood(t) < -8);
}

export function isFakeLeadIdentity(
  input: { name?: string; email?: string; digits10?: string },
  cfg: FakeLeadConfig = {},
): boolean {
  const name = input.name?.trim() ?? "";
  const email = input.email?.trim() ?? "";
  const digits10 = input.digits10 ?? "";
  const tokens = name.split(/\s+/).filter(Boolean);

  if (digits10 && isFakePhoneDigits10(digits10, cfg)) return true;
  if (name && PROFANITY_RE.test(name)) return true;
  if (name && TEST_WORD_RE.test(name)) return true;
  if (email && PROFANITY_RE.test(email)) return true;
  if (name && JOKE_NAME_RE.test(name)) return true;
  if (email && isFakeEmail(email, cfg)) return true;

  if (name) {
    if (name.length > 45) return true;
    if (isGibberishName(name, GIBBERISH_THRESHOLD)) return true;
    if (hasPeriodicMash(name, email)) return true;
    if (name.includes("@") && tokens.every((t) => t.toLowerCase() !== email.toLowerCase())) return true;
    if (tokens.length >= 2 && tokens[tokens.length - 1].toLowerCase() === "doe") return true;
    if (!email && tokens.length === 1) {
      if (isGibberishName(name, GIBBERISH_THRESHOLD_BARE)) return true;
      const letters = tokens[0].toLowerCase().replace(/[^a-z]/g, "");
      if (letters.length >= 2 && /^(.)\1+$/.test(letters)) return true;
      if (FILLER_WORDS.has(tokens[0].toLowerCase())) return true;
      if (letters.length >= 3 && letters.length <= 5 && !/[aeiouy]/.test(letters)) return true;
    }
  } else if (email && hasPeriodicMash("", email)) {
    return true;
  }
  return false;
}

/* ---------------- submission gates ---------------- */

export type Gate = { outcome: "reject"; error: string } | { outcome: "ghost"; reason: string } | { outcome: "process" };

export type LeadInput = {
  timeline?: string;
  business_owner?: string;
  capital?: string;
  city?: string;
  name?: string;
  phone?: string;
  email?: string;
};

function classifyPhone(phone: string | undefined): Gate | { outcome: "ok"; digits: string } {
  const national = nationalDigitsFromPhoneInput(phone ?? "");
  if (national.length < 10) return { outcome: "reject", error: "Enter a valid 10-digit phone number." };
  const digits = normalizePhoneDigits10(phone) ?? normalizePhoneDigits10(national);
  if (!digits) return { outcome: "ghost", reason: "phone_not_us_ca" };
  return { outcome: "ok", digits };
}

function oneOf(value: string | undefined, options: readonly string[]): boolean {
  return !!value && (options as readonly string[]).includes(value);
}

export function classifyFullSubmission(input: LeadInput, cfg: FakeLeadConfig = {}): Gate {
  if (!oneOf(input.timeline, TIMELINE_OPTIONS)) return { outcome: "reject", error: "Please tell us how soon you plan to start." };
  if (!oneOf(input.business_owner, BUSINESS_OWNER_OPTIONS))
    return { outcome: "reject", error: "Please tell us whether you own a business." };
  if (!oneOf(input.capital, CAPITAL_OPTIONS)) return { outcome: "reject", error: "Please answer the capital question." };
  const city = (input.city ?? "").trim();
  if (!city) return { outcome: "reject", error: "Please enter your city." };
  const name = (input.name ?? "").trim();
  if (!name) return { outcome: "reject", error: "Please enter your real name." };
  if (!isValidEmail(input.email)) return { outcome: "reject", error: "Please enter a valid email address." };
  const phoneGate = classifyPhone(input.phone);
  if (phoneGate.outcome !== "ok") return phoneGate;
  const digits = phoneGate.digits;
  if (isObviousFakeText(name)) return { outcome: "ghost", reason: "fake_name" };
  if (isObviousFakeText(city)) return { outcome: "ghost", reason: "fake_city" };
  if (isObviousFakePhone10(digits)) return { outcome: "ghost", reason: "fake_phone" };
  if (isObviousFakeEmail(input.email)) return { outcome: "ghost", reason: "fake_email" };
  if (isFakeLeadIdentity({ name, email: input.email, digits10: digits }, cfg)) return { outcome: "ghost", reason: "fake_identity" };
  return { outcome: "process" };
}

/** Partial (abandonment) save: phone required, everything else optional but must be valid when present. */
export function classifyPartialSubmission(input: LeadInput, cfg: FakeLeadConfig = {}): Gate {
  const phoneGate = classifyPhone(input.phone);
  if (phoneGate.outcome !== "ok") return phoneGate;
  const digits = phoneGate.digits;
  if (input.timeline && !oneOf(input.timeline, TIMELINE_OPTIONS)) return { outcome: "reject", error: "Invalid timeline." };
  if (input.business_owner && !oneOf(input.business_owner, BUSINESS_OWNER_OPTIONS))
    return { outcome: "reject", error: "Invalid business owner answer." };
  if (input.capital && !oneOf(input.capital, CAPITAL_OPTIONS)) return { outcome: "reject", error: "Invalid capital answer." };
  const name = (input.name ?? "").trim();
  const city = (input.city ?? "").trim();
  if (name && isObviousFakeText(name)) return { outcome: "ghost", reason: "fake_name" };
  if (city && isObviousFakeText(city)) return { outcome: "ghost", reason: "fake_city" };
  if (isObviousFakePhone10(digits)) return { outcome: "ghost", reason: "fake_phone" };
  if (isObviousFakeEmail(input.email)) return { outcome: "ghost", reason: "fake_email" };
  if (isFakeLeadIdentity({ name, email: input.email, digits10: digits }, cfg)) return { outcome: "ghost", reason: "fake_identity" };
  return { outcome: "process" };
}

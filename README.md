# roof-funnel

Static, dependency-free Start Roof Rejuvenating dealer funnel (originally a GoHighLevel funnel),
served from GitHub Pages at **https://startroofrejuvenating.com**.

Every page is the funnel's own custom-code block, captured verbatim from the live GHL page payload on
2026-10-14, wrapped in the same section / row / column shell and the same page-level CSS the page
builder applied, so the rendered result is the same pixel for pixel.

| Path | Source GHL page | Notes |
| --- | --- | --- |
| `/` | Funnel (`/`) | Opt-in: Vidalytics VSL + dealer application survey |
| `/thankyou-page/` | Thankyou Page | post-booking page, 15 proof screenshots |
| `/thankyou/` | Thankyou (clone, 2026-10-11) | same page without the first two proof screenshots |
| `/privacy-policy/` | Privacy Policy | |

## Application survey (custom form)

The ROASForm embed on the opt-in page is replaced by a custom survey (`assets/survey.js` +
`assets/survey.css`, no build step) modelled on the Stone Systems funnel survey: one question per
screen, tap answers auto-advance, endowed progress bar, back button, Safari-safe slide strip, mobile
keyboard focus handling, honeypot, US/CA phone gating, and an abandonment partial-save once a valid
phone exists (tab hidden, page left, or 5 min idle).

Steps: timeline → business owner → capital → city → phone → email → name → **Check My Eligibility**.

Routing after submit (decided server-side):

| Answer / verdict | Result |
| --- | --- |
| capital = "No - I do not qualify to book a call" | not-a-fit panel, lead stored and sent to GHL with `qualified=false` |
| anything else | GHL booking calendar inline (prefilled), or the thanks panel while `data-calendar` is empty |
| honeypot, non US/CA IP, fake/test identity | thanks panel; nothing stored, nothing sent |

Configure on the `#dealer-survey` element in `index.html`:
`data-api` = Worker base URL, `data-calendar` = GHL booking-widget URL
(`https://api.leadconnectorhq.com/widget/booking/<calendarId>`). Set the calendar's post-booking
redirect to `https://startroofrejuvenating.com/thankyou-page/` so the Add To Calendar button works.

## API (`worker/`)

Cloudflare Worker at `https://api.startroofrejuvenating.com` with a D1 database (`roof-funnel-leads`).

- `POST /lead` and `POST /lead/partial`: CORS origin check → 8/min rate limit (binding) + 40/h (D1)
  → honeypot → IP country → validation gate (reject 400 / ghost silent / process) → D1 upsert by phone
  (a partial never overwrites a full; a full upgrades the partial, also under `superseded_phone`) →
  GHL inbound webhook pushed in the background with `ghl_status` recorded on the row.
- `GET /leads?since=<ISO>&limit=<n>` with `Authorization: Bearer <ADMIN_TOKEN>`: JSON export.
- Secrets (`npx wrangler secret put`): `GHL_WEBHOOK_URL` (LeadConnector inbound-webhook workflow URL;
  until set, rows get `ghl_status=skipped`), `ADMIN_TOKEN`. Optional vars:
  `FAKE_LEAD_TEST_PHONE_PREFIXES`, `FAKE_LEAD_INTERNAL_EMAIL_DOMAINS`.
- Dev: `cd worker && npm install && npm test && npm run typecheck`; `npx wrangler dev --local --port 8787`
  (add `--var "ALLOWED_COUNTRIES:US,CA,<your country>"` when testing from outside US/CA, the geo gate
  silently drops everything else); deploy with `npm run deploy`, migrations with `npm run migrate`.

Logs mask names, phones and emails.

## Soft credit check (SimpleCheck)

A completed application whose capital answer starts with "Yes" gets one SimpleCheck Qualify pre-qualification
(`worker/src/simplecheck.ts`, `POST https://api.simplecheck.ai/api/pre-qualification`, token in the JSON body).
It runs in the background after the lead is stored (`creditFlow` in `worker/src/index.ts`), so capture, routing
and booking never wait on it and never fail because of it.

- **Consent gate:** the survey shows the disclosure under its submit button and sends
  `credit_consent: "soft-pull-v1"` with the full submit. The flag counts only on `/lead` with an allowed `Origin`.
  The version, time and IP are stored (`credit_consent`, `credit_consent_at`, `credit_consent_ip`). Change the
  disclosure wording → bump the version in `assets/survey.js` and `CREDIT_CONSENT_VERSION` together.
- **Not checked:** not-qualified leads, partials, submits without the flag, non-US IP countries, names that are
  not a plain first + last name, and anything over the daily cap (`SIMPLECHECK_DAILY_CAP`, default 40 per 24 h).
- **One check per person:** rows are reused by phone, so `credit_identity` (SHA-256 of name + email + phone)
  records who was checked. A different person on the same row wipes the earlier consent and result; the same
  person on a new row within 30 days reuses the earlier result instead of pulling again.
- **Stored:** `credit_status` (`success` / `invalid` / `queued` / `skipped` / `error`), score, offer status and
  amounts, debt-to-income, income, credit freeze, `credit_prequal_id`. The address / alternate-email enrichment
  SimpleCheck returns is not read or stored. `error` and `skipped` release the row so a later submit can retry.
- **Shown to the team:** GHL custom fields written by contact id (Credit Score, Credit Offer Status, Credit
  Offer Amount, Debt To Income, Estimated Income, Credit Freeze) and a follow-up message in #lead-alerts. A
  paused account, rejected token, rate limit or reached cap posts one notice per 6 hours.
- **Config:** secret `SIMPLECHECK_API_TOKEN` (`npx wrangler secret put SIMPLECHECK_API_TOKEN`); unset = no checks.
  `SIMPLECHECK_MODE = "off"` in `wrangler.toml` pauses them. SimpleCheck bills per successful report and returns
  a cached result for the same person within 7 days; limit 100 requests/hour.
- **Deploy order:** `npm run migrate` first, then `npm run deploy`. (A Worker deployed without the columns still
  captures and routes leads; only the credit step fails, and logs it.)
- **Local run:** `--var SIMPLECHECK_API_TOKEN:stub --var SIMPLECHECK_API_URL:http://127.0.0.1:<port>/api/pre-qualification`
  against a stub (the override is honoured for localhost only), plus `--var "CORTANA_WEBHOOKS:{}"` so test leads
  never reach the real step webhooks.

## Native booking step

After a qualified submit the widget calls `GET /slots` on the Worker. When `GHL_PIT`, `GHL_LOCATION_ID`
and `GHL_CALENDAR_ID` are set, it renders its own calendar (month grid, time list, time-zone picker)
from GHL's free-slots API and books through `POST /book`, which upserts the contact, creates the
appointment on the calendar, stores the appointment on the lead row and redirects to
`/thankyou-page/` with the `date` / `event_start_time` / `event_end_time` / `timezone` params the
Add To Calendar button reads. Until those three values exist, `/slots` answers `configured:false`
and the widget falls back to the `data-calendar` GHL widget URL, or the thanks panel if that is
empty too. Set them with `npx wrangler secret put GHL_PIT` and the two ids in `wrangler.toml`
(or as secrets), then `npm run deploy`.

## What is real vs. placeholder

Nothing is a placeholder. All embeds are the originals (Vidalytics VSL, Wistia players, Google Drive previews, Google Slides warranty deck) and all 17 images that were
inlined as base64 on the GHL pages were decoded into real files under `assets/`.

## Tracking and third-party hooks

The funnel-level HEAD tracking code (Spendback pixel, five Meta pixels, Callix attribution) is in
every page's `<head>` between the `Funnel HEAD tracking code` comments. The funnel-level BODY code
on GHL could only run through `<img onerror>` hacks; here its two effects are plain markup instead:
the footer **Contact** link on the opt-in page and the **Your Pre-Call Resources** section at the
bottom of both thank-you pages.

Leftovers from the original page, by design (1:1 copy):

- The "Add To My Calendar" button reads `date` / `event_start_time` / `event_end_time` query
  params, while ROASForm sends `roasform_start` / `roasform_end`, so the button stays a `#` link.
  Same behaviour as the live page.

## Deliberate differences from the live page

- The live opt-in page never loads Poppins / Montserrat (no font-face reaches it), so it renders in
  the browser's fallback sans-serif. This copy does the same; a commented-out Google Fonts `<link>` in
  `index.html` loads them if you want the intended fonts.
- Pages have a `<title>` (the GHL pages had none, apart from the thank-you and privacy pages, which
  set their own).

## Hosting

GitHub Pages, branch `main`, root. `CNAME` holds the custom domain. DNS is a flattened CNAME at the
apex of `startroofrejuvenating.com` (Cloudflare, DNS-only) pointing at `michaelvanhoutte1.github.io`.

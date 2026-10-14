# roof-funnel

Static, dependency-free copy of the OnYa Roof dealer funnel (originally a GoHighLevel funnel at
onyaroof.com), served from GitHub Pages at **https://startroofrejuvenating.com**.

Every page is the funnel's own custom-code block, captured verbatim from the live GHL page payload on
2026-10-14, wrapped in the same section / row / column shell and the same page-level CSS the page
builder applied, so the rendered result is the same pixel for pixel.

| Path | Source GHL page | Notes |
| --- | --- | --- |
| `/` | OnyaRoof Funnel (`/`) | Opt-in: Vidalytics VSL + ROASForm application |
| `/onyaroof-funnel-page/` | same page, GHL's internal path | identical copy of `/` |
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

Configure on the `#dealer-survey` element in `index.html` (and the `onyaroof-funnel-page/` copy):
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

## What is real vs. placeholder

Nothing is a placeholder. All embeds are the originals (Vidalytics VSL, Wistia players, Google Drive previews, Google Slides warranty deck) and all 17 images that were
inlined as base64 on the GHL pages were decoded into real files under `assets/`.

## Tracking and third-party hooks

The funnel-level HEAD tracking code (Spendback pixel, five Meta pixels, Callix attribution) is in
every page's `<head>` between the `Funnel HEAD tracking code` comments. The funnel-level BODY code
on GHL could only run through `<img onerror>` hacks; here its two effects are plain markup instead:
the footer **Contact** link on the opt-in page and the **Your Pre-Call Resources** section at the
bottom of both thank-you pages.

Things that still point at the old domain / accounts, by design (1:1 copy):

- Footer links: `https://onyaroof.com/privacy-policy` and the viktor.page Contact page.
- Callix attribution script loads from `m.onyaroof.com`.
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

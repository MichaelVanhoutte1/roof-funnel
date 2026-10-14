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

## What is real vs. placeholder

Nothing is a placeholder. All embeds are the originals (Vidalytics VSL, ROASForm application,
Wistia players, Google Drive previews, Google Slides warranty deck) and all 17 images that were
inlined as base64 on the GHL pages were decoded into real files under `assets/`.

## Tracking and third-party hooks

The funnel-level HEAD tracking code (Spendback pixel, five Meta pixels, Callix attribution) is in
every page's `<head>` between the `Funnel HEAD tracking code` comments. The funnel-level BODY code
on GHL could only run through `<img onerror>` hacks; here its two effects are plain markup instead:
the footer **Contact** link on the opt-in page and the **Your Pre-Call Resources** section at the
bottom of both thank-you pages.

Things that still point at the old domain / accounts, by design (1:1 copy):

- ROASForm form `030490-d116fb-7124fd` redirects to its configured thank-you URL after booking.
  Change the redirect in ROASForm to `https://startroofrejuvenating.com/thankyou-page/` to keep the
  funnel on this domain.
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

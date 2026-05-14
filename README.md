# APC Beta — application flow

Mobile-first beta test of the Algarve Property Compliance (APC) onboarding flow.

- Live URL: https://beta.algarvepropertycompliance.com
- Backend: Supabase (project `uxvnyjasnkdijazilasz`) — magic-link auth, Postgres, Storage
- Frontend: vanilla HTML/CSS/JS, hosted on GitHub Pages

## Pages

- `/` — 8-step tester flow (Welcome → Confirm area → Property → Compliance Q → Documents → Summary → Feedback → Complete)
- `/admin.html` — admin dashboard (KPIs, funnel, testers, feedback). Gated by `ADMIN_EMAILS` in `config.js`.

## Data model

All data is **test only**. No real filings, no payments, no real PII required.

- `testers` — one row per signed-in user
- `beta_applications` — one row per run-through of the flow (a tester can restart)
- `beta_feedback` — feedback submitted at the end of a flow
- `session_tracking` — per-step events for funnel + drop-off analysis
- Storage bucket `beta-documents` — private, 10 MB max, PDF/JPG/PNG only

RLS: testers see only their own rows; admin emails (dave/joe/liam/hello@APC) see everything.

## Config

`config.js` holds the Supabase URL + publishable (anon) key. Safe to ship to the browser — RLS does the gatekeeping.

## Banner

Every page shows **BETA TEST MODE — NOT A REAL COMPLIANCE APPLICATION** at the top to prevent confusion.

---

APC remains portable and is not dependent on PC as the only execution agent.

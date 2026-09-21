# @bugbusterhq/dashboard

A read-only issue viewer against the Query API (`docs/api.md`). Still no auth flow, no settings,
no build step, no framework — matching this project's own "build for validated need" principle
(see `docs/architecture/ingest-pipeline.md` §10) — but the single HTML file now carries real
day-to-day triage UX rather than a bare table + JSON dump, since that's a need real usage of this
dashboard already validated.

## Running it

```bash
pnpm dev
# open http://localhost:5173
```

Or simply open `src/index.html` directly in a browser — it's a single self-contained file with no
build step. Either way, enter the backend URL and an API key (stored only in that browser's
`localStorage`, never sent anywhere but the backend you point it at).

## What it does

- `GET /issues` on load and "Load more" (cursor-paginated), rendered as a sortable table — click
  any column header to sort the currently-loaded issues by it.
- A filter bar: free-text search over fingerprint/release, and a fidelity filter (all / exact only
  / sampled only), plus a stats strip (issues loaded, total occurrences, how many are
  sampled/degraded).
- Click a row for a structured detail view: overview (count, users affected, adjusted count,
  first/last seen, releases), duration percentiles, a top-endpoints bar chart, and — via
  `GET /issues/:fingerprint/exemplars` — full exemplar cards (role, trace id, source location,
  error message, and a copyable stack trace). The full issue JSON is still available in a
  collapsible "Raw JSON" section for anyone who wants it.
- `fidelity` is always shown as a badge — whether `count` is exact or a sampled/weighted estimate
  (Appendix A's FIDELITY invariant: never present a sampled count as unconditional truth).

## What it deliberately doesn't do

No live updates (polling/websockets), no multi-org switcher, no write/management actions. All
reasonable next additions once someone is using this daily and asking for them specifically.

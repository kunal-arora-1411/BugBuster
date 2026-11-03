# @bugbusterhq/dashboard

A read-only viewer for issues and logs against the Query API (`docs/api.md`). Still no auth flow, no settings,
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
`localStorage`, never sent anywhere but the backend you point it at). **Settings** changes them
later, and the theme switch offers System, Light and Dark.

## Issues view

- `GET /issues` on load and "Load more" (cursor-paginated), rendered as a table: issue (error type
  and message, fingerprint, first seen), service, events, users, release and last seen. Click a
  column header to sort the loaded issues by it.
- A filter bar: free-text search over message, fingerprint, release and service, and a count filter
  (all / exact / estimated). The line under the title sums up what is shown and whether every count
  is exact.
- **Service:** once issues come from more than one service, a Service column and filter appear.
  The filter is applied by the backend (`GET /issues?service=`), so paging stays within that
  service; its choices come from `GET /issues/facets`. With one service both stay hidden.
- Click a row to open its detail **inline, under the row** (click again or press Esc to close):
  events, users, first and last seen; request duration percentiles; the top endpoints; the
  service(s) and releases; example events (role, trace id, source location, error message and a
  copyable stack trace, via `GET /issues/:fingerprint/exemplars`); and *What this request logged*,
  the log lines of the failing request. When that request went through several services, each line
  is labeled with its service. The raw issue JSON is in a collapsible "Raw JSON" section.
- **Copy issue** copies everything above as one Markdown report, to paste into an AI coding agent
  or a ticket.
- Every count shows whether it is exact or a sampled estimate (Appendix A's FIDELITY invariant:
  never present a sampled count as unconditional truth).

## Logs view

A second tab (`#logs` is linkable) for application logs, newest first:

- **Filters:** free-text search (substring, case-insensitive), time range, service, environment,
  and level chips (debug / info / warn / error). Service and environment dropdowns are populated
  from `GET /logs/facets`.
- **Row detail:** click a line for the full multi-line message, version/environment, structured
  fields, and the log id. "Copy JSON" copies the exact stored record.
- **From an error to its logs:** every exemplar on an issue has a *View logs for this request*
  button; a line with a trace id has *Show everything in this request*. Both filter the stream to
  that one trace (shown as a removable chip) across all retained time.
- **Live:** polls every 3 s and merges new lines in at the top without reloading. It re-fetches 15 s
  of recent history each poll (lines arrive out of order) and de-duplicates by id. Best-effort by
  design: under a flood it follows the newest lines rather than guaranteeing every one — use the
  normal paged view for exact history. It pauses while the tab is hidden and keeps at most 2,000
  lines in memory.

Everything from the wire is rendered as text, never HTML — a log line is untrusted input, and a line
containing `<img onerror=...>` shows up literally.

## What it deliberately doesn't do

No live updates for issues (only the Logs view's Live tail), no multi-org switcher, and no
write or management actions: organizations and keys are managed on the backend's `/admin` page.
Reasonable next additions once someone is using this daily and asking for them specifically.

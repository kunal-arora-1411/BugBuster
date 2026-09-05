# @bugbuster/dashboard

A minimal, read-only issue viewer against the Query API (`docs/api.md`). Deliberately small — no
auth flow, no settings, no build step — matching this project's own "build for validated need"
principle (see `docs/architecture/ingest-pipeline.md` §10). If richer dashboard UX is ever
justified, it earns that complexity with real usage, not speculatively now.

## Running it

```bash
pnpm dev
# open http://localhost:5173
```

Or simply open `src/index.html` directly in a browser — it's a single self-contained file with no
build step. Either way, enter the backend URL and an API key (stored only in that browser's
`localStorage`, never sent anywhere but the backend you point it at).

## What it does

- `GET /issues` on load and on demand, rendered as a table.
- Click a row to see the full issue JSON, including `fidelity` — whether `count` is exact or a
  sampled/weighted estimate (Appendix A's FIDELITY invariant: never present a sampled count as
  unconditional truth).

## What it deliberately doesn't do

No pagination UI, no exemplar detail view (the Query API only returns `exemplarRefs`, not resolved
payloads, yet — see `docs/api.md`), no live updates, no multi-org switcher. All reasonable next
additions once someone is actually using this daily and asking for them.

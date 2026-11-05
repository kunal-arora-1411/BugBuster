/**
 * The admin page, served at GET /admin when BUGBUSTER_ADMIN_TOKEN is set. One self-contained HTML
 * document (no build step, no third-party script) in the same visual system as the dashboard
 * (packages/dashboard/src/index.html): a tinted frame around one sheet, light and dark.
 *
 * It holds no data. Everything it shows comes from the /admin/* routes, called with the admin
 * token the operator types in; the token is kept in sessionStorage only, so it is forgotten when
 * the tab closes. Text from the server is only ever set with textContent.
 *
 * Kept as a TypeScript string so it ships inside the compiled backend everywhere (Vercel included)
 * without bundler configuration for a separate file. The script inside deliberately uses no
 * template literals, so this outer one needs no escaping.
 */
export const ADMIN_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>BugBuster admin</title>
<meta name="theme-color" content="#f2f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d0f10" media="(prefers-color-scheme: dark)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<script>
  try { var t = localStorage.getItem("bb_theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) {}
</script>
<style>
  :root {
    color-scheme: light;
    --frame: #f2f5f7; --sheet: #ffffff; --raised: #f4f6f8; --active: #e6eaed;
    --border: #e3e7ea; --rule: #eef1f3; --control: #cdd2d6;
    --text: #131416; --muted: #5b6064; --accent: #1b6c80;
    --primary: #17191b; --primary-ink: #ffffff;
    --negative: #b4232a; --positive: #1e7b4f;
    --pill-negative-bg: #ffedea; --pill-negative-ink: #831c1e;
    --pill-warning-bg: #fff6e0;  --pill-warning-ink: #7a3e0b;
    --pill-neutral-bg: #eceff1;  --pill-neutral-ink: #353a3e;
    --pill-positive-bg: #dcfae5; --pill-positive-ink: #04250e;
    --focus: #1b6c80;
    --font: "IBM Plex Sans", Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
    --sidebar: 228px; --control-height: 32px; --ease: cubic-bezier(0.23, 1, 0.32, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --frame: #0d0f10; --sheet: #15181a; --raised: #1b1f21; --active: #252a2d;
      --border: #262b2e; --rule: #1f2326; --control: #3d4448;
      --text: #eef0f1; --muted: #a4abb0; --accent: #5cb8cc;
      --primary: #eef0f1; --primary-ink: #0d0f10; --negative: #f07a82; --positive: #4cc38a;
      --pill-negative-bg: #3a1c20; --pill-negative-ink: #f7a6ac;
      --pill-warning-bg: #36270d;  --pill-warning-ink: #f0c47a;
      --pill-neutral-bg: #262b2e;  --pill-neutral-ink: #c9cfd3;
      --pill-positive-bg: #17301f; --pill-positive-ink: #7fd8a5;
      --focus: #5cb8cc;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --frame: #0d0f10; --sheet: #15181a; --raised: #1b1f21; --active: #252a2d;
    --border: #262b2e; --rule: #1f2326; --control: #3d4448;
    --text: #eef0f1; --muted: #a4abb0; --accent: #5cb8cc;
    --primary: #eef0f1; --primary-ink: #0d0f10; --negative: #f07a82; --positive: #4cc38a;
    --pill-negative-bg: #3a1c20; --pill-negative-ink: #f7a6ac;
    --pill-warning-bg: #36270d;  --pill-warning-ink: #f0c47a;
    --pill-neutral-bg: #262b2e;  --pill-neutral-ink: #c9cfd3;
    --pill-positive-bg: #17301f; --pill-positive-ink: #7fd8a5;
    --focus: #5cb8cc;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: var(--frame); color: var(--text); font: 400 14px/20px var(--font); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; }
  @media (pointer: fine) { html { overscroll-behavior: none; } }
  h1, h2, h3, p { margin: 0; }
  h1, h2 { text-wrap: balance; }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .mono { font-family: var(--mono); font-size: 13px; }
  .muted { color: var(--muted); }
  .skip { position: absolute; left: 8px; top: -48px; z-index: 10; padding: 8px 12px; background: var(--primary); color: var(--primary-ink); border-radius: 6px; }
  .skip:focus { top: 8px; }

  button, input, select { font: inherit; color: inherit; }
  button { height: var(--control-height); padding: 0 12px; border-radius: 6px; border: 1px solid var(--control); background: var(--sheet); color: var(--text); font-weight: 500; cursor: pointer; white-space: nowrap; touch-action: manipulation; transition: background-color 120ms var(--ease), transform 120ms var(--ease); }
  button:hover { background: var(--raised); }
  button:active { transform: scale(0.98); }
  button:disabled { cursor: default; opacity: 0.6; }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-ink); }
  button.primary:hover { background: color-mix(in srgb, var(--primary) 86%, var(--sheet)); }
  button.quiet { border-color: transparent; background: transparent; color: var(--muted); }
  button.quiet:hover { background: var(--raised); color: var(--text); }
  button.danger { color: var(--negative); border-color: color-mix(in srgb, var(--negative) 45%, var(--control)); }
  button.danger.filled { background: var(--negative); border-color: var(--negative); color: var(--sheet); }
  button.link { height: auto; padding: 0; border: none; background: none; color: var(--accent); }
  button.link:hover { background: none; text-decoration: underline; text-underline-offset: 3px; }
  input, select { height: var(--control-height); padding: 0 10px; border-radius: 6px; border: 1px solid var(--control); background: var(--sheet); min-width: 0; }
  select { padding-right: 30px; appearance: none; cursor: pointer; background: var(--sheet) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%237a8085' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 11px center; }
  input::placeholder { color: var(--muted); opacity: 1; }

  .app { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: 100vh; }
  .side { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 20px; padding: 16px 12px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px; font-weight: 600; font-size: 15px; }
  .brand svg { color: var(--accent); flex: none; }
  .brand .tag { font-weight: 500; color: var(--muted); }
  .scope { padding: 0 8px; display: grid; gap: 2px; }
  .scope .host { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scope .state { font-size: 12px; color: var(--muted); }
  .nav { display: grid; gap: 2px; }
  .nav a { display: flex; align-items: center; height: 32px; padding: 0 8px; border-radius: 8px; color: var(--muted); text-decoration: none; font-weight: 500; }
  .nav a:hover { color: var(--text); background: color-mix(in srgb, var(--active) 60%, transparent); }
  .nav a[aria-current="page"] { color: var(--text); background: var(--active); }
  .side-foot { margin-top: auto; display: grid; gap: 12px; padding: 0 8px; justify-items: start; }
  .side-foot .label { font-size: 12px; color: var(--muted); }
  .seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px; background: var(--active); }
  .seg button, .seg a { height: 28px; padding: 0 10px; border: none; background: transparent; color: var(--muted); border-radius: 6px; font-weight: 500; text-decoration: none; display: inline-flex; align-items: center; }
  .seg button:hover { background: transparent; color: var(--text); }
  .seg button[aria-pressed="true"], .seg a[aria-current="page"] { background: var(--sheet); color: var(--text); }
  .sheet { margin: 8px 8px 8px 0; min-height: calc(100vh - 16px); background: var(--sheet); border: 1px solid var(--border); border-radius: 16px; padding: 24px; min-width: 0; }
  .phonebar { display: none; }

  .titlerow { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .titlerow h1 { font-size: 22px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { margin-top: 4px; color: var(--muted); max-width: 72ch; }
  .actions { display: flex; gap: 8px; align-items: center; }
  .toolbar { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
  .toolbar .search { flex: 1 1 260px; max-width: 360px; }
  .status { margin-top: 12px; min-height: 20px; color: var(--muted); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .status.err { color: var(--negative); }

  .split { margin-top: 8px; }
  .split.has-detail { display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 24px; align-items: start; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 400; font-size: 12px; color: var(--muted); height: 36px; padding: 0 12px; white-space: nowrap; }
  td { padding: 12px; border-top: 1px solid var(--rule); vertical-align: top; }
  th.num, td.num { text-align: right; white-space: nowrap; }
  .split.has-detail .col-hide { display: none; } /* the open detail shows these figures */
  tr.row { cursor: pointer; }
  tr.row:hover td { background: color-mix(in srgb, var(--raised) 70%, transparent); }
  tr.row.selected td { background: var(--active); }
  .row-title { display: block; height: auto; padding: 0; border: none; background: none; text-align: left; font-weight: 500; color: var(--text); white-space: normal; }
  .row-title:hover { background: none; }
  .row-sub { margin-top: 2px; font-size: 12px; color: var(--muted); }
  .pill { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 4px; font-size: 12px; font-weight: 500; white-space: nowrap; flex: none; }
  .pill.neutral { background: var(--pill-neutral-bg); color: var(--pill-neutral-ink); }
  .pill.warning { background: var(--pill-warning-bg); color: var(--pill-warning-ink); }
  .pill.negative { background: var(--pill-negative-bg); color: var(--pill-negative-ink); }
  .pill.positive { background: var(--pill-positive-bg); color: var(--pill-positive-ink); }
  .empty { padding: 32px 0; display: grid; gap: 8px; justify-items: start; max-width: 60ch; }
  .empty h2 { font-size: 16px; font-weight: 600; }
  .empty p { color: var(--muted); }

  .detail { border: 1px solid var(--border); border-radius: 8px; position: sticky; top: 8px; max-height: calc(100vh - 16px); overflow: auto; overscroll-behavior: contain; }
  .detail-head { padding: 16px 20px; border-bottom: 1px solid var(--rule); display: grid; gap: 6px; }
  .detail-head .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .detail-head h2 { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
  .detail-head .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: var(--muted); }
  .block { padding: 16px 20px; border-bottom: 1px solid var(--rule); display: grid; gap: 12px; }
  .block:last-child { border-bottom: none; }
  .block h3 { font-size: 14px; font-weight: 600; }
  .block p.help { color: var(--muted); font-size: 13px; }
  .inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .inline input { flex: 1 1 180px; }
  .field { display: grid; gap: 6px; }
  .field label { font-weight: 500; }
  .field .hint { font-size: 12px; color: var(--muted); }
  .field input, .field select { height: 36px; }
  .keys { display: grid; }
  .key { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 10px 0; border-top: 1px solid var(--rule); align-items: center; }
  .key:first-child { border-top: none; padding-top: 0; }
  .key .name { font-weight: 500; overflow-wrap: anywhere; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .key .when { grid-column: 1; font-size: 12px; color: var(--muted); }
  .key .act { grid-row: 1 / span 2; grid-column: 2; }
  .key.revoked .name { color: var(--muted); }
  .sizes { width: 100%; }
  .sizes td, .sizes th { padding: 6px 0; border: none; }
  .sizes th { height: auto; padding: 0 0 4px; }
  .sizes td + td, .sizes th + th { padding-left: 12px; }

  .reveal { display: grid; gap: 12px; }
  .reveal .secret { display: flex; gap: 8px; align-items: stretch; }
  .reveal code { flex: 1; min-width: 0; padding: 8px 10px; border-radius: 6px; background: var(--raised); font: 13px/20px var(--mono); overflow-wrap: anywhere; user-select: all; }
  .reveal .warn { padding: 10px 12px; border-radius: 6px; background: var(--pill-warning-bg); color: var(--pill-warning-ink); }

  .signin { max-width: 440px; display: grid; gap: 24px; padding-top: 8px; }
  .signin form { display: grid; gap: 16px; }

  dialog { padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--sheet); color: var(--text); width: min(480px, calc(100vw - 32px)); box-shadow: 0 16px 48px rgb(0 0 0 / 0.18); overscroll-behavior: contain; }
  dialog::backdrop { background: rgb(0 0 0 / 0.32); }
  .d-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px 0; gap: 8px; }
  .d-head h2 { font-size: 16px; font-weight: 600; }
  .d-body { padding: 16px 20px 20px; display: grid; gap: 16px; }
  .d-foot { display: flex; justify-content: flex-end; gap: 8px; }

  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0ms !important; animation: none !important; } }
  @media (max-width: 1199px) {
    .split.has-detail { display: block; }
    .split.has-detail .list-pane { display: none; }
    .detail { position: static; max-height: none; }
  }
  @media (max-width: 1100px) {
    .app { display: block; }
    .side { display: none; }
    .phonebar { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 12px 0 16px; position: sticky; top: 0; z-index: 2; background: var(--frame); }
    .phonebar .brand { padding: 0; margin-right: auto; }
    .sheet { margin: 0 8px 8px; min-height: calc(100vh - 60px); }
  }
  @media (max-width: 760px) {
    .sheet { margin: 0; border: none; border-radius: 0; padding: 20px 16px; min-height: calc(100vh - 52px); }
    .phonebar .brand .tag { display: none; }
  }
  @media (max-width: 420px) {
    .phonebar .brand span { display: none; }
    .col-hide { display: none; }
    th, td { padding-left: 8px; padding-right: 8px; }
    .toolbar .search { max-width: none; flex-basis: 100%; }
  }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="mark" viewBox="0 0 20 20"><path d="M3 4.5h14M5.5 8.5h9M8 12.5h4M9.5 16.5h1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>
</svg>

<div class="app">
  <aside class="side" aria-label="BugBuster admin">
    <div class="brand"><svg width="20" height="20" aria-hidden="true"><use href="#mark"/></svg><span translate="no">BugBuster</span><span class="tag">Admin</span></div>
    <div class="scope"><span class="host" id="scopeHost"></span><span class="state" id="scopeState">Not signed in</span></div>
    <nav class="nav" aria-label="Sections" id="sideNav" hidden>
      <a href="#orgs" data-view="orgs">Organizations</a>
      <a href="#storage" data-view="storage">Storage</a>
      <a href="#activity" data-view="activity">Activity</a>
    </nav>
    <div class="side-foot">
      <span class="label" id="themeLabel">Theme</span>
      <div class="seg" role="group" aria-labelledby="themeLabel" data-theme-control></div>
      <button class="quiet" id="signOutBtn" hidden style="margin-left:-8px">Sign out</button>
    </div>
  </aside>

  <header class="phonebar">
    <div class="brand"><svg width="20" height="20" aria-hidden="true"><use href="#mark"/></svg><span translate="no">BugBuster</span><span class="tag">Admin</span></div>
    <nav class="seg" aria-label="Sections" id="phoneNav" hidden>
      <a href="#orgs" data-view="orgs">Orgs</a>
      <a href="#storage" data-view="storage">Storage</a>
      <a href="#activity" data-view="activity">Activity</a>
    </nav>
    <button class="quiet" id="phoneMenuBtn" aria-label="Theme and sign out">More</button>
  </header>

  <main class="sheet" id="main" tabindex="-1">
    <section id="view-signin" class="signin" aria-labelledby="signinTitle" hidden>
      <div>
        <h1 id="signinTitle" style="font-size:22px; line-height:28px; font-weight:600">Sign in to admin</h1>
        <p class="sub">Use this backend’s admin token (BUGBUSTER_ADMIN_TOKEN). It is kept only in this browser tab and forgotten when you close it.</p>
      </div>
      <form id="signinForm" novalidate>
        <div class="field">
          <label for="adminToken">Admin token</label>
          <input id="adminToken" name="adminToken" type="password" autocomplete="current-password" spellcheck="false">
        </div>
        <div class="inline"><button class="primary" type="submit" id="signinBtn">Sign in</button><span class="muted" id="signinError" role="alert"></span></div>
      </form>
    </section>

    <section id="view-orgs" aria-labelledby="orgsTitle" hidden>
      <div class="titlerow">
        <div><h1 id="orgsTitle">Organizations</h1><p class="sub" id="orgsSummary">Every organization on this backend.</p></div>
        <div class="actions"><button id="orgsRefreshBtn">Refresh</button><button class="primary" id="newOrgBtn">New organization</button></div>
      </div>
      <div class="toolbar"><input id="orgSearch" class="search" type="search" placeholder="Filter by name or id…" aria-label="Filter organizations" autocomplete="off" spellcheck="false"></div>
      <div class="status" id="orgsStatus" role="status" aria-live="polite"></div>
      <div class="split" id="orgsSplit">
        <div class="list-pane">
          <table id="orgsTable" hidden>
            <thead><tr>
              <th style="width:36%">Organization</th><th>Status</th><th class="num">Keys</th>
              <th class="col-hide">Log retention</th><th class="num col-hide">Stored</th><th class="num col-hide">Logs, last 7 days</th>
            </tr></thead>
            <tbody id="orgsBody"></tbody>
          </table>
          <div class="empty" id="orgsEmpty" hidden></div>
        </div>
        <aside class="detail" id="orgDetail" hidden aria-label="Organization details"></aside>
      </div>
    </section>

    <section id="view-storage" aria-labelledby="storageTitle" hidden>
      <div class="titlerow">
        <div><h1 id="storageTitle">Storage</h1><p class="sub" id="storageSummary">What each organization stores in MongoDB.</p></div>
        <div class="actions"><button id="storageRefreshBtn">Refresh</button></div>
      </div>
      <div class="status" id="storageStatus" role="status" aria-live="polite"></div>
      <table id="storageTable" hidden style="margin-top:8px">
        <thead><tr>
          <th style="width:28%">Organization</th><th class="num">Logs</th><th class="num col-hide">Issues</th><th class="num col-hide">Examples</th>
          <th class="num">Total on disk</th><th class="num col-hide">Logs per day</th><th class="col-hide">Log compression</th>
        </tr></thead>
        <tbody id="storageBody"></tbody>
      </table>
      <div class="block" style="padding-left:0; padding-right:0; margin-top:24px; border-top:1px solid var(--rule)">
        <h3>Leftover example events</h3>
        <p class="help">Older backends stored example events that no issue shows. They only take space; deleting them changes nothing anyone can see.</p>
        <div class="inline"><span id="leftoverText" class="muted">Counting…</span><button id="cleanupBtn" class="danger" hidden>Delete leftovers</button></div>
      </div>
    </section>

    <section id="view-activity" aria-labelledby="activityTitle" hidden>
      <div class="titlerow">
        <div><h1 id="activityTitle">Activity</h1><p class="sub">Changes made through admin, newest first.</p></div>
        <div class="actions"><button id="activityRefreshBtn">Refresh</button></div>
      </div>
      <div class="status" id="activityStatus" role="status" aria-live="polite"></div>
      <table id="activityTable" hidden style="margin-top:8px">
        <thead><tr><th style="width:20%">When</th><th>Change</th><th>Organization</th><th class="col-hide">Detail</th></tr></thead>
        <tbody id="activityBody"></tbody>
      </table>
      <div class="empty" id="activityEmpty" hidden><h2>No changes yet</h2><p>Creating organizations, keys and changing settings is listed here.</p></div>
    </section>
  </main>
</div>

<dialog id="newOrgDialog" aria-labelledby="newOrgTitle">
  <div class="d-head"><h2 id="newOrgTitle">New organization</h2><button class="quiet" data-close>Close</button></div>
  <form class="d-body" id="newOrgForm" novalidate>
    <div class="field"><label for="noName">Name</label><input id="noName" name="name" autocomplete="off" placeholder="Acme Corp…"></div>
    <div class="field"><label for="noId">Organization id</label><input id="noId" name="orgId" autocomplete="off" spellcheck="false" placeholder="acme…" aria-describedby="noIdHint"><span class="hint" id="noIdHint">Permanent. Lowercase letters, digits, - and _, up to 40 characters. It also names the org’s database.</span></div>
    <div class="field"><label for="noRetention">Log retention</label><select id="noRetention"></select></div>
    <div class="field"><label for="noKey">First key’s name</label><input id="noKey" autocomplete="off" value="Default key" aria-describedby="noKeyHint"><span class="hint" id="noKeyHint">Name keys after who uses them, like “checkout-api production”.</span></div>
    <div class="d-foot"><span class="muted" id="newOrgError" role="alert" style="margin-right:auto"></span><button type="button" data-close>Cancel</button><button class="primary" type="submit">Create organization</button></div>
  </form>
</dialog>

<dialog id="revealDialog" aria-labelledby="revealTitle">
  <div class="d-head"><h2 id="revealTitle">Copy the API key now</h2></div>
  <div class="d-body reveal">
    <p id="revealIntro"></p>
    <div class="secret"><code id="revealKey" translate="no"></code><button id="revealCopy">Copy</button></div>
    <p class="warn">This key is shown only once. Only a hash is stored, so it can’t be retrieved later; if it is lost, create a new key and revoke this one.</p>
    <div class="d-foot"><button class="primary" id="revealDone">I’ve saved it</button></div>
  </div>
</dialog>

<dialog id="confirmDialog" aria-labelledby="confirmTitle">
  <div class="d-head"><h2 id="confirmTitle"></h2></div>
  <div class="d-body"><p id="confirmBody"></p><div class="d-foot"><button id="confirmCancel">Cancel</button><button id="confirmOk" class="danger filled"></button></div></div>
</dialog>

<dialog id="moreDialog" aria-labelledby="moreTitle">
  <div class="d-head"><h2 id="moreTitle">Settings</h2><button class="quiet" data-close>Close</button></div>
  <div class="d-body"><div class="field"><span class="label" id="themeLabel2" style="font-weight:500">Theme</span><div class="seg" role="group" aria-labelledby="themeLabel2" data-theme-control style="justify-self:start"></div></div><button id="phoneSignOut" style="justify-self:start">Sign out</button></div>
</dialog>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = "bb_admin_token";
  var token = "";
  try { token = sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) {}
  var view = "orgs";
  var orgs = [];
  var storageByOrg = {};
  var storageReport = null;
  var selectedOrg = null;
  var defaultRetention = 7;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  var nf = new Intl.NumberFormat();
  function num(n) { return typeof n === "number" ? nf.format(n) : "—"; }
  function plural(n, one, many) { return num(n) + " " + (n === 1 ? one : (many || one + "s")); }
  function bytes(n) {
    if (typeof n !== "number") return "—";
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB", "TB"], v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
  }
  var rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  var dtf = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  function ago(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return "—";
    var s = Math.round((d.getTime() - Date.now()) / 1000), a = Math.abs(s);
    if (a < 45) return "just now";
    if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
    if (a < 30 * 86400) return rtf.format(Math.round(s / 86400), "day");
    return dtf.format(d);
  }
  function stamp(node, iso) { node.title = dtf.format(new Date(iso)); return node; }
  function retentionText(days, overridden) {
    var base = days === 0 ? "Kept forever" : plural(days, "day");
    return overridden ? base : base + " (default)";
  }

  /* ---- theme ---- */
  function applyTheme(choice) {
    try {
      if (choice === "system") { delete document.documentElement.dataset.theme; localStorage.removeItem("bb_theme"); }
      else { document.documentElement.dataset.theme = choice; localStorage.setItem("bb_theme", choice); }
    } catch (e) {}
    document.querySelectorAll("[data-theme-control] button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.choice === choice)); });
  }
  document.querySelectorAll("[data-theme-control]").forEach(function (g) {
    [["system", "System"], ["light", "Light"], ["dark", "Dark"]].forEach(function (c) {
      var b = el("button", null, c[1]); b.type = "button"; b.dataset.choice = c[0];
      b.addEventListener("click", function () { applyTheme(c[0]); });
      g.appendChild(b);
    });
  });
  applyTheme(document.documentElement.dataset.theme || "system");

  /* ---- API ---- */
  function api(method, path, body) {
    var init = { method: method, headers: { Authorization: "Bearer " + token } };
    if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) { signOut("This admin token wasn’t accepted."); throw new Error("Not signed in."); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error ? capital(data.error) + "." : "The backend answered HTTP " + res.status + ".");
        return data;
      });
    }, function () { throw new Error("Can’t reach the backend. Check your connection and try again."); });
  }
  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function status(id, text, isError, retry) {
    var s = $(id); s.textContent = text || ""; s.className = "status" + (isError ? " err" : "");
    if (retry) { var b = el("button", null, "Try again"); b.addEventListener("click", retry); s.appendChild(b); }
  }

  /* ---- sign in / out ---- */
  function signedIn() { return !!token; }
  function signOut(message) {
    token = ""; try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    orgs = []; selectedOrg = null;
    render();
    if (message) $("signinError").textContent = message;
  }
  $("signinForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = $("adminToken").value.trim();
    if (!t) { $("signinError").textContent = "Enter the admin token."; return; }
    token = t;
    $("signinBtn").disabled = true; $("signinError").textContent = "";
    api("GET", "/admin/orgs").then(function (data) {
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e2) {}
      $("adminToken").value = "";
      orgs = data.orgs || [];
      render();
      loadAll();
    }).catch(function (err) {
      if (signedIn()) { token = ""; $("signinError").textContent = err.message; }
    }).finally(function () { $("signinBtn").disabled = false; });
  });
  $("signOutBtn").addEventListener("click", function () { signOut(); });
  $("phoneSignOut").addEventListener("click", function () { $("moreDialog").close(); signOut(); });
  $("phoneMenuBtn").addEventListener("click", function () { $("moreDialog").showModal(); });
  document.querySelectorAll("dialog [data-close]").forEach(function (b) { b.addEventListener("click", function () { b.closest("dialog").close(); }); });

  /* ---- views ---- */
  function render() {
    var inn = signedIn();
    $("view-signin").hidden = inn;
    $("sideNav").hidden = !inn; $("phoneNav").hidden = !inn; $("signOutBtn").hidden = !inn; $("phoneSignOut").hidden = !inn;
    $("scopeHost").textContent = location.host;
    $("scopeState").textContent = inn ? "Signed in for this tab" : "Not signed in";
    ["orgs", "storage", "activity"].forEach(function (v) { $("view-" + v).hidden = !inn || v !== view; });
    document.querySelectorAll("a[data-view]").forEach(function (a) {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (!inn) { setTimeout(function () { $("adminToken").focus(); }, 0); return; }
    if (view === "orgs") renderOrgs();
    if (view === "storage") renderStorage();
  }
  function setView(v) {
    view = v; render();
    if (!signedIn()) return;
    if (v === "activity") loadActivity();
    if (v === "storage" && !storageReport) loadStorage();
  }
  window.addEventListener("hashchange", function () { setView(viewFromHash()); });
  function viewFromHash() { var h = location.hash.slice(1); return h === "storage" || h === "activity" ? h : "orgs"; }

  /* ---- organizations ---- */
  function loadAll() {
    loadOrgs();
    loadStorage();
  }
  function loadOrgs() {
    status("orgsStatus", "Loading…");
    return api("GET", "/admin/orgs").then(function (data) {
      orgs = data.orgs || [];
      status("orgsStatus", "");
      renderOrgs();
      if (selectedOrg) {
        var again = orgs.filter(function (o) { return o.orgId === selectedOrg; })[0];
        if (again) renderOrgDetail(again); else closeDetail();
      }
    }).catch(function (err) { if (signedIn()) status("orgsStatus", err.message, true, loadOrgs); });
  }
  function loadStorage() {
    status("storageStatus", "Loading…");
    return api("GET", "/admin/storage").then(function (data) {
      storageReport = data; storageByOrg = {};
      (data.orgs || []).forEach(function (o) { storageByOrg[o.orgId] = o; });
      defaultRetention = data.defaultLogRetentionDays;
      status("storageStatus", "");
      renderStorage(); renderOrgs();
      if (selectedOrg) { var o = orgs.filter(function (x) { return x.orgId === selectedOrg; })[0]; if (o) renderOrgDetail(o); }
      countLeftovers();
    }).catch(function (err) { if (signedIn()) status("storageStatus", err.message, true, loadStorage); });
  }
  function lines7(orgId) {
    var s = storageByOrg[orgId]; if (!s) return undefined;
    return (s.logsPerDay || []).reduce(function (sum, d) { return sum + d.lines; }, 0);
  }

  function renderOrgs() {
    if (view !== "orgs") return;
    var q = $("orgSearch").value.trim().toLowerCase();
    var list = orgs.filter(function (o) { return !q || (o.name + " " + o.orgId).toLowerCase().indexOf(q) >= 0; });
    var disabled = orgs.filter(function (o) { return o.disabled; }).length;
    $("orgsSummary").textContent = orgs.length === 0 ? "Every organization on this backend." :
      plural(orgs.length, "organization") + (disabled ? ", " + num(disabled) + " disabled" : "") +
      (storageReport ? ". " + bytes(storageReport.totalBytes) + " stored in total." : ".");
    var body = $("orgsBody"); body.textContent = "";
    var empty = $("orgsEmpty");
    if (list.length === 0) {
      $("orgsTable").hidden = true; empty.hidden = false; empty.textContent = "";
      if (orgs.length === 0) {
        empty.appendChild(el("h2", null, "No organizations yet"));
        empty.appendChild(el("p", null, "Create one for each team or customer that sends errors and logs to this backend."));
        var b = el("button", "primary", "New organization"); b.addEventListener("click", openNewOrg); empty.appendChild(b);
      } else {
        empty.appendChild(el("h2", null, "No organizations match this filter"));
      }
      return;
    }
    empty.hidden = true; $("orgsTable").hidden = false;
    list.forEach(function (o) {
      var tr = el("tr", "row" + (o.orgId === selectedOrg ? " selected" : ""));
      var c1 = el("td"); var t = el("button", "row-title", o.name); t.type = "button"; c1.appendChild(t);
      c1.appendChild(el("div", "row-sub mono", o.orgId));
      var c2 = el("td"); c2.appendChild(o.disabled ? el("span", "pill negative", "Disabled") : el("span", "pill positive", "Active"));
      var active = o.keys.filter(function (k) { return !k.revokedAt; }).length;
      var c3 = el("td", "num", num(active));
      var c4 = el("td", "col-hide", retentionText(o.logRetentionDays, o.retentionOverridden));
      var s = storageByOrg[o.orgId];
      var c5 = el("td", "num col-hide", s ? bytes(s.totalBytes) : "—");
      var l = lines7(o.orgId);
      var c6 = el("td", "num col-hide", l === undefined ? "—" : num(l));
      tr.append(c1, c2, c3, c4, c5, c6);
      tr.addEventListener("click", function () { selectOrg(o.orgId); });
      body.appendChild(tr);
    });
  }
  $("orgSearch").addEventListener("input", renderOrgs);
  $("orgsRefreshBtn").addEventListener("click", loadAll);

  function selectOrg(orgId) {
    selectedOrg = orgId;
    var o = orgs.filter(function (x) { return x.orgId === orgId; })[0];
    renderOrgs();
    if (o) renderOrgDetail(o);
  }
  function closeDetail() {
    selectedOrg = null; $("orgDetail").hidden = true; $("orgsSplit").classList.remove("has-detail"); renderOrgs();
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && selectedOrg && !document.querySelector("dialog[open]")) closeDetail();
  });

  function retentionOptions(select, current, overridden, includeDefault) {
    select.textContent = "";
    var opts = [];
    if (includeDefault) opts.push(["default", "Backend default (" + plural(defaultRetention, "day") + ")"]);
    [7, 14, 30, 90, 180, 365].forEach(function (d) { opts.push([String(d), plural(d, "day")]); });
    opts.push(["0", "Keep forever"]);
    var known = opts.map(function (x) { return x[0]; });
    if (overridden && known.indexOf(String(current)) < 0) opts.push([String(current), plural(current, "day")]);
    opts.forEach(function (x) { var op = el("option", null, x[1]); op.value = x[0]; select.appendChild(op); });
    select.value = overridden ? String(current) : (includeDefault ? "default" : "7");
  }

  function renderOrgDetail(o) {
    var d = $("orgDetail"); d.textContent = ""; d.hidden = false;
    $("orgsSplit").classList.add("has-detail");

    var head = el("div", "detail-head");
    var top = el("div", "top");
    var h = el("h2", null, o.name); h.id = "orgDetailTitle"; d.setAttribute("aria-labelledby", "orgDetailTitle");
    var close = el("button", "quiet", "Close"); close.setAttribute("aria-label", "Close organization details");
    close.addEventListener("click", closeDetail);
    top.append(h, close); head.appendChild(top);
    var meta = el("div", "meta");
    meta.appendChild(el("span", "mono", o.orgId));
    meta.appendChild(o.disabled ? el("span", "pill negative", "Disabled") : el("span", "pill positive", "Active"));
    meta.appendChild(stamp(el("span", null, "created " + ago(o.createdAt)), o.createdAt));
    head.appendChild(meta);
    d.appendChild(head);

    // Keys first: who can send and read is what an operator opens this for most.
    var keys = el("section", "block");
    keys.appendChild(el("h3", null, "API keys"));
    keys.appendChild(el("p", "help", "One key per service or person, so each can be revoked without affecting the others. Revoked keys stop working within a minute."));
    var list = el("div", "keys");
    var sorted = o.keys.slice().sort(function (a, b) { return (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0) || (a.createdAt < b.createdAt ? 1 : -1); });
    if (sorted.length === 0) list.appendChild(el("p", "muted", "This organization has no keys."));
    sorted.forEach(function (k) {
      var row = el("div", "key" + (k.revokedAt ? " revoked" : ""));
      var name = el("div", "name"); name.appendChild(el("span", null, k.name));
      if (k.revokedAt) name.appendChild(el("span", "pill neutral", "Revoked"));
      row.appendChild(name);
      var when = el("div", "when");
      when.append(stamp(el("span", null, "Created " + ago(k.createdAt)), k.createdAt));
      when.append(". ");
      if (k.revokedAt) when.append(stamp(el("span", null, "Revoked " + ago(k.revokedAt)), k.revokedAt));
      else if (k.lastUsedAt) when.append(stamp(el("span", null, "Last used " + ago(k.lastUsedAt)), k.lastUsedAt));
      else when.append("Not used yet");
      row.appendChild(when);
      if (!k.revokedAt) {
        var rv = el("button", "danger act", "Revoke");
        rv.setAttribute("aria-label", "Revoke key " + k.name);
        rv.addEventListener("click", function () {
          confirmAction("Revoke “" + k.name + "”?", "Anything using this key gets “invalid api key” from now on (within a minute on every backend instance). The organization’s other keys keep working. This can’t be undone.", "Revoke key", function () {
            return api("DELETE", "/admin/orgs/" + encodeURIComponent(o.orgId) + "/keys/" + encodeURIComponent(k.keyId)).then(loadOrgs);
          });
        });
        row.appendChild(rv);
      }
      list.appendChild(row);
    });
    keys.appendChild(list);
    var form = el("form", "inline"); form.noValidate = true;
    var label = el("label", "sr-only", "New key name"); label.setAttribute("for", "newKeyName"); label.style.position = "absolute"; label.style.width = "1px"; label.style.height = "1px"; label.style.overflow = "hidden"; label.style.clip = "rect(0 0 0 0)";
    var input = el("input"); input.id = "newKeyName"; input.placeholder = "New key’s name, e.g. orders-worker…"; input.autocomplete = "off";
    var add = el("button", null, "Create key"); add.type = "submit";
    var err = el("span", "muted"); err.setAttribute("role", "alert");
    form.append(label, input, add, err);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var n = input.value.trim(); if (!n) { err.textContent = "Name the key first."; input.focus(); return; }
      add.disabled = true; err.textContent = "";
      api("POST", "/admin/orgs/" + encodeURIComponent(o.orgId) + "/keys", { name: n }).then(function (key) {
        reveal("Key “" + key.name + "” for " + o.name + ":", key.apiKey);
        loadOrgs();
      }).catch(function (x) { err.textContent = x.message; }).finally(function () { add.disabled = false; });
    });
    keys.appendChild(form);
    d.appendChild(keys);

    // Name
    var nameBlock = el("section", "block");
    nameBlock.appendChild(el("h3", null, "Name"));
    var nf2 = el("form", "inline"); nf2.noValidate = true;
    var nl = el("label", null, "Organization name"); nl.setAttribute("for", "orgNameInput"); nl.style.position = "absolute"; nl.style.width = "1px"; nl.style.height = "1px"; nl.style.overflow = "hidden"; nl.style.clip = "rect(0 0 0 0)";
    var ni = el("input"); ni.id = "orgNameInput"; ni.value = o.name; ni.autocomplete = "off";
    var ns = el("button", null, "Save name"); ns.type = "submit";
    var ne = el("span", "muted"); ne.setAttribute("role", "alert");
    nf2.append(nl, ni, ns, ne);
    nf2.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = ni.value.trim(); if (!v || v === o.name) return;
      ns.disabled = true;
      api("PATCH", "/admin/orgs/" + encodeURIComponent(o.orgId), { name: v }).then(function () { ne.textContent = "Saved."; return loadOrgs(); })
        .catch(function (x) { ne.textContent = x.message; }).finally(function () { ns.disabled = false; });
    });
    nameBlock.appendChild(nf2);
    d.appendChild(nameBlock);

    // Retention
    var rb = el("section", "block");
    rb.appendChild(el("h3", null, "Log retention"));
    rb.appendChild(el("p", "help", "Log lines older than this are deleted automatically. A change applies at once."));
    var rf = el("form", "inline"); rf.noValidate = true;
    var rl = el("label", null, "Log retention"); rl.setAttribute("for", "orgRetention"); rl.style.position = "absolute"; rl.style.width = "1px"; rl.style.height = "1px"; rl.style.overflow = "hidden"; rl.style.clip = "rect(0 0 0 0)";
    var rs = el("select"); rs.id = "orgRetention";
    retentionOptions(rs, o.logRetentionDays, o.retentionOverridden, true);
    var rsave = el("button", null, "Save retention"); rsave.type = "submit";
    var re = el("span", "muted"); re.setAttribute("role", "alert");
    rf.append(rl, rs, rsave, re);
    rf.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = rs.value === "default" ? null : Number(rs.value);
      rsave.disabled = true;
      api("PATCH", "/admin/orgs/" + encodeURIComponent(o.orgId), { logRetentionDays: v }).then(function () { re.textContent = "Saved."; return loadOrgs(); })
        .catch(function (x) { re.textContent = x.message; }).finally(function () { rsave.disabled = false; });
    });
    rb.appendChild(rf);
    d.appendChild(rb);

    // Storage
    var s = storageByOrg[o.orgId];
    var sb = el("section", "block");
    sb.appendChild(el("h3", null, "Storage"));
    if (!s) sb.appendChild(el("p", "muted", "Loading…"));
    else {
      var t = el("table", "sizes");
      var hr = el("tr"); ["", "Documents", "On disk", "Indexes"].forEach(function (x, i) { hr.appendChild(el("th", i ? "num" : null, x)); });
      var th = el("thead"); th.appendChild(hr); t.appendChild(th);
      var tb = el("tbody");
      [["Logs", "logs"], ["Issues", "issues"], ["Example events", "events"], ["Cause links", "issue_links"]].forEach(function (pair) {
        var c = s.collections[pair[1]]; if (!c) return;
        var r = el("tr"); r.appendChild(el("td", null, pair[0]));
        r.appendChild(el("td", "num", num(c.documents))); r.appendChild(el("td", "num", bytes(c.storageBytes))); r.appendChild(el("td", "num", bytes(c.indexBytes)));
        tb.appendChild(r);
      });
      t.appendChild(tb); sb.appendChild(t);
      var note = "Logs are compressed with " + (s.collections.logs.compression || "the server default") + ".";
      if (s.unreferencedEvents) note += " " + plural(s.unreferencedEvents, "leftover example event") + " can be deleted under Storage.";
      sb.appendChild(el("p", "help", note));
    }
    d.appendChild(sb);

    // Access
    var ab = el("section", "block");
    ab.appendChild(el("h3", null, "Access"));
    if (o.disabled) {
      ab.appendChild(el("p", "help", "Disabled " + ago(o.disabledAt) + ". Its keys get “organization is disabled” for sending and reading. Its data is kept."));
      var en = el("button", null, "Enable organization");
      en.addEventListener("click", function () {
        en.disabled = true;
        api("PATCH", "/admin/orgs/" + encodeURIComponent(o.orgId), { disabled: false }).then(loadOrgs)
          .catch(function (x) { status("orgsStatus", x.message, true); }).finally(function () { en.disabled = false; });
      });
      ab.appendChild(en);
    } else {
      ab.appendChild(el("p", "help", "Disabling refuses every request with this organization’s keys, from its services and from the dashboard, until it is enabled again. Nothing is deleted."));
      var dis = el("button", "danger", "Disable organization");
      dis.style.justifySelf = "start";
      dis.addEventListener("click", function () {
        confirmAction("Disable " + o.name + "?", "Its services stop being able to send errors and logs, and nobody can read its data in the dashboard, until you enable it again (within a minute on every backend instance). Its data is kept.", "Disable organization", function () {
          return api("PATCH", "/admin/orgs/" + encodeURIComponent(o.orgId), { disabled: true }).then(loadOrgs);
        });
      });
      ab.appendChild(dis);
    }
    d.appendChild(ab);
    if (window.matchMedia("(max-width: 1199px)").matches) d.scrollIntoView({ block: "start" });
  }

  /* ---- new organization ---- */
  function openNewOrg() {
    $("newOrgForm").reset(); $("noKey").value = "Default key"; $("newOrgError").textContent = "";
    retentionOptions($("noRetention"), defaultRetention, false, true);
    $("newOrgDialog").showModal(); $("noName").focus();
  }
  $("newOrgBtn").addEventListener("click", openNewOrg);
  var idTouched = false;
  $("noId").addEventListener("input", function () { idTouched = true; });
  $("noName").addEventListener("input", function () {
    if (idTouched) return;
    $("noId").value = $("noName").value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  });
  $("newOrgDialog").addEventListener("close", function () { idTouched = false; });
  $("newOrgForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("noName").value.trim(), id = $("noId").value.trim(), keyName = $("noKey").value.trim();
    var errEl = $("newOrgError");
    if (!name) { errEl.textContent = "Enter a name."; $("noName").focus(); return; }
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) { errEl.textContent = "Use 1–40 lowercase letters, digits, - or _ for the id."; $("noId").focus(); return; }
    var body = { orgId: id, name: name, keyName: keyName || "Default key" };
    if ($("noRetention").value !== "default") body.logRetentionDays = Number($("noRetention").value);
    errEl.textContent = "";
    api("POST", "/admin/orgs", body).then(function (org) {
      $("newOrgDialog").close();
      selectedOrg = org.orgId;
      reveal("The first key for " + org.name + ", “" + body.keyName + "”:", org.apiKey);
      loadAll();
    }).catch(function (x) { errEl.textContent = x.message; });
  });

  /* ---- shown-once key ---- */
  function reveal(intro, key) {
    $("revealIntro").textContent = intro;
    $("revealKey").textContent = key;
    $("revealCopy").textContent = "Copy";
    $("revealDialog").showModal();
  }
  $("revealCopy").addEventListener("click", function () {
    var k = $("revealKey").textContent, b = $("revealCopy");
    if (navigator.clipboard) navigator.clipboard.writeText(k).then(function () { b.textContent = "Copied"; }).catch(function () {});
  });
  $("revealDone").addEventListener("click", function () { $("revealKey").textContent = ""; $("revealDialog").close(); });
  $("revealDialog").addEventListener("cancel", function (e) { e.preventDefault(); }); // must be dismissed on purpose

  /* ---- confirm ---- */
  var pending = null;
  function confirmAction(title, body, okLabel, run) {
    $("confirmTitle").textContent = title; $("confirmBody").textContent = body; $("confirmOk").textContent = okLabel;
    pending = run; $("confirmDialog").showModal(); $("confirmCancel").focus();
  }
  $("confirmCancel").addEventListener("click", function () { pending = null; $("confirmDialog").close(); });
  $("confirmOk").addEventListener("click", function () {
    var run = pending; pending = null; if (!run) return;
    $("confirmOk").disabled = true;
    run().then(function () { $("confirmDialog").close(); })
      .catch(function (x) { $("confirmBody").textContent = x.message; })
      .finally(function () { $("confirmOk").disabled = false; });
  });

  /* ---- storage ---- */
  function renderStorage() {
    if (view !== "storage" || !storageReport) return;
    var r = storageReport;
    $("storageSummary").textContent = bytes(r.totalBytes) + " on disk across " + plural(r.orgs.length, "organization") +
      ". Logs are kept for " + plural(r.defaultLogRetentionDays, "day") + " unless an organization says otherwise.";
    var body = $("storageBody"); body.textContent = "";
    $("storageTable").hidden = r.orgs.length === 0;
    r.orgs.forEach(function (o) {
      var tr = el("tr");
      var c1 = el("td"); c1.appendChild(el("div", null, o.name)); c1.appendChild(el("div", "row-sub", retentionText(o.logRetentionDays, o.retentionOverridden)));
      var c = o.collections;
      var perDay = (o.logsPerDay || []).reduce(function (s, d) { return s + d.lines; }, 0) / 7;
      tr.append(c1,
        el("td", "num", bytes(c.logs.storageBytes + c.logs.indexBytes)),
        el("td", "num col-hide", bytes(c.issues.storageBytes + c.issues.indexBytes)),
        el("td", "num col-hide", bytes(c.events.storageBytes + c.events.indexBytes)),
        el("td", "num", bytes(o.totalBytes)),
        el("td", "num col-hide", (o.logsPerDay || []).length ? num(Math.round(perDay)) : "—"),
        el("td", "col-hide", c.logs.compression || "—"));
      body.appendChild(tr);
    });
  }
  $("storageRefreshBtn").addEventListener("click", loadStorage);

  var leftovers = 0;
  function countLeftovers() {
    if (!storageReport) return;
    leftovers = storageReport.orgs.reduce(function (s, o) { return s + (o.unreferencedEvents || 0); }, 0);
    $("leftoverText").textContent = leftovers ? plural(leftovers, "leftover example event") + " across all organizations." : "None. Nothing to clean up.";
    $("cleanupBtn").hidden = !leftovers;
  }
  $("cleanupBtn").addEventListener("click", function () {
    confirmAction("Delete " + plural(leftovers, "leftover example event") + "?", "These are example events no issue shows. Deleting them frees space and changes nothing anyone can see. Events written in the last ten minutes are left alone.", "Delete leftovers", function () {
      return api("POST", "/admin/maintenance/cleanup-events", { dryRun: false }).then(function (res) {
        return loadStorage().then(function () {
          status("storageStatus", plural(res.total, "leftover example event") + " deleted.");
        });
      });
    });
  });

  /* ---- activity ---- */
  var ACTIONS = {
    "org.created": "Organization created", "org.renamed": "Organization renamed", "org.retention_changed": "Log retention changed",
    "org.disabled": "Organization disabled", "org.enabled": "Organization enabled", "key.created": "Key created",
    "key.revoked": "Key revoked", "events.cleaned_up": "Leftover example events deleted"
  };
  function loadActivity() {
    status("activityStatus", "Loading…");
    api("GET", "/admin/events?limit=100").then(function (data) {
      status("activityStatus", "");
      var list = data.events || [];
      var names = {}; orgs.forEach(function (o) { names[o.orgId] = o.name; });
      var body = $("activityBody"); body.textContent = "";
      $("activityTable").hidden = list.length === 0; $("activityEmpty").hidden = list.length > 0;
      list.forEach(function (ev) {
        var tr = el("tr");
        tr.append(stamp(el("td", "muted", ago(ev.at)), ev.at), el("td", null, ACTIONS[ev.action] || ev.action),
          el("td", null, ev.orgId ? (names[ev.orgId] || ev.orgId) : "—"), el("td", "col-hide muted", ev.detail || ""));
        body.appendChild(tr);
      });
    }).catch(function (err) { if (signedIn()) status("activityStatus", err.message, true, loadActivity); });
  }
  $("activityRefreshBtn").addEventListener("click", loadActivity);

  /* ---- start ---- */
  view = viewFromHash();
  render();
  if (signedIn()) { loadAll(); if (view === "activity") loadActivity(); }
})();
</script>
</body>
</html>
`;

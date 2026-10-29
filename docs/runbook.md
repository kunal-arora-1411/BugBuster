# Local Runbook

Everything below is what actually exists and actually runs today — no aspirational steps. For the
automated equivalent of this whole sequence (used as a real test, not just documentation), see
`examples/demo-app/test/full-pipeline.test.ts`.

## 1. Install and build

```bash
pnpm install
pnpm build
```

## 2. Start MongoDB

```bash
docker compose -f infra/docker-compose.yml up -d
```

(If Docker isn't available, any local `mongod` on `mongodb://localhost:27017` works — the backend
doesn't care how it got there.)

## 3. Create an organization

There's no HTTP endpoint for this yet (`docs/api.md`'s "Not yet built") — at pilot scale, a CLI
run by whoever operates the backend is the honest v1 answer:

```bash
cd packages/backend
pnpm create-org org_demo "Demo Org" bugbuster_org_demo demo-api-key
```

This writes one record into the shared `bugbuster_control` database.

## 4. Start the backend

```bash
cd packages/backend
BUGBUSTER_CONTROL_DB_URI=mongodb://localhost:27017 PORT=8080 pnpm start
```

## 5. Start the Agent

```bash
cd packages/agent
BUGBUSTER_AGENT_SOCKET=/tmp/bugbuster-agent.sock \
BUGBUSTER_BACKEND_URL=http://localhost:8080/ingest \
BUGBUSTER_API_KEY=demo-api-key \
pnpm start
```

(On Windows, use a named pipe path instead, e.g. `\\.\pipe\bugbuster-agent`.)

## 6. Start the demo app

```bash
cd examples/demo-app
BUGBUSTER_API_KEY=demo-api-key \
BUGBUSTER_AGENT_SOCKET=/tmp/bugbuster-agent.sock \
pnpm dev
```

## 7. Trigger an error and query it back

```bash
curl http://localhost:3000/throw
curl http://localhost:3000/throw   # again — should fold into the same issue, count: 2

curl -H "Authorization: Bearer demo-api-key" http://localhost:8080/issues
```

## 8. Send and read logs

The demo app already logs. Generate some and read them back:

```bash
curl http://localhost:3000/orders/42
curl http://localhost:3000/checkout        # fails: an error + the log lines leading up to it

curl -H "Authorization: Bearer demo-api-key" "http://localhost:8080/logs?limit=10"
curl -H "Authorization: Bearer demo-api-key" "http://localhost:8080/logs?level=error&q=payment"
```

Set `BUGBUSTER_LOG_RETENTION_DAYS` on the backend (default 7) to control how long logs are kept.

## What's not here yet

See `docs/api.md` for the full response shapes. The dashboard (`packages/dashboard`, `pnpm dev`)
shows both issues and logs.

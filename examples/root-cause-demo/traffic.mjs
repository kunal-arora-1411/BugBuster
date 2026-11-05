/* global process, console, fetch */
// Root-cause demo (docs/architecture/root-cause-graph.md): three services in a chain, plus one
// unrelated failure, all reporting to a running backend. Afterwards the dashboard shows checkout's
// and orders' issues as caused by inventory's database timeout.
//
//   pnpm build
//   BUGBUSTER_API_KEY=<key> node examples/root-cause-demo/traffic.mjs
import { createServer } from "node:http";
import {
  createExpressIntegration,
  init,
  instrumentFetch,
} from "../../packages/sdk-node/dist/index.js";

const backendUrl = process.env.BUGBUSTER_INGEST_URL ?? "http://localhost:8080/ingest";
const apiKey = process.env.BUGBUSTER_API_KEY;
if (!apiKey) {
  console.error("Set BUGBUSTER_API_KEY to an organization's API key.");
  process.exit(1);
}

function service(project) {
  const client = init({
    project,
    apiKey,
    backendUrl,
    release: "demo",
    agentSocketPath: "/nonexistent/agent.sock", // always direct mode, even if an Agent runs here
    flushMaxDelayMs: 60_000,
  });
  return { client, bb: createExpressIntegration(client) };
}

function serve(bb, handler) {
  const server = createServer((req, res) =>
    bb.requestHandler(req, res, () => {
      Promise.resolve(handler(req, res)).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    }),
  );
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)),
  );
}

instrumentFetch();
const inventory = service("inventory");
const orders = service("orders");
const checkout = service("checkout");
const billing = service("billing");

class MongoServerSelectionError extends Error {
  name = "MongoServerSelectionError";
}
async function reserveStock() {
  throw new MongoServerSelectionError("Server selection timed out after 30000 ms");
}

// inventory: the database is down — the real cause.
const inventoryUrl = await serve(inventory.bb, async (_req, res) => {
  try {
    await reserveStock();
  } catch (err) {
    inventory.bb.captureException(err);
    res.statusCode = 503;
    res.end();
  }
});
// orders: fails because inventory did, and reports its own error.
const ordersUrl = await serve(orders.bb, async (_req, res) => {
  const r = await fetch(`${inventoryUrl}/reserve`);
  if (!r.ok) {
    const err = new Error(`inventory responded ${r.status}`);
    err.name = "UpstreamError";
    orders.bb.captureException(err);
  }
  res.statusCode = r.ok ? 201 : 502;
  res.end();
});
// checkout: fails because orders did, and reports nothing — the SDK records a HandledHttpError.
const checkoutUrl = await serve(checkout.bb, async (_req, res) => {
  const r = await fetch(`${ordersUrl}/orders`);
  res.statusCode = r.ok ? 200 : 500;
  res.end();
});
// billing: an unrelated bug, so not every issue is part of the chain.
const billingUrl = await serve(billing.bb, (_req, res) => {
  billing.bb.captureException(
    new TypeError("Cannot read properties of undefined (reading 'currency')"),
  );
  res.statusCode = 500;
  res.end();
});

for (let i = 0; i < 40; i++) await fetch(`${checkoutUrl}/checkout`);
for (let i = 0; i < 7; i++) await fetch(`${billingUrl}/invoice`);

for (const s of [inventory, orders, checkout, billing]) await s.client.shutdown();
console.log(
  "Sent. Open the dashboard: checkout and orders should say they were caused by inventory.",
);
process.exit(0);

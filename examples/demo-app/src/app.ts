import express, { type Express } from "express";
import { createExpressIntegration, type BugBusterClient } from "@bugbusterhq/sdk-node";
import type { BugBusterExpressIntegration } from "@bugbusterhq/sdk-node";

/**
 * The instrumented app, split from the process bootstrap (index.ts) so the end-to-end test can
 * mount exactly this app against a real SDK/Agent/backend without starting a second server
 * process.
 *
 * Shows the whole integration surface in one place:
 *  - `bb.requestHandler`  — per-request trace context, the 5xx safety net, and (with
 *    `logRequests`) one structured access-log line per request, tagged with that trace id.
 *  - `bb.log.*`           — application logs; inside a request they inherit the same trace id.
 *  - `captureException`   — grouped errors; the same trace id again, which is what lets the
 *    dashboard jump from an issue's example straight to every log line that request wrote.
 */
export function buildApp(client: BugBusterClient): {
  app: Express;
  bb: BugBusterExpressIntegration;
} {
  const bb = createExpressIntegration(client, {
    logRequests: { ignorePaths: ["/healthz"] }, // health probes would drown everything else
  });

  const app = express();
  app.use(bb.requestHandler); // mount first, before any route

  app.get("/healthz", (_req, res) => {
    res.send("ok");
  });

  app.get("/", (_req, res) => {
    res.send(
      "BugBuster demo-app is running. Try GET /orders/42, /checkout (fails), /throw, /throw-slow.",
    );
  });

  // A normal request: one structured application log line, plus the automatic access-log line.
  app.get("/orders/:id", (req, res) => {
    bb.log.info("order lookup", { orderId: req.params.id, source: "demo" });
    res.json({ id: req.params.id, status: "shipped" });
  });

  // A failing request: ordinary logs leading up to the failure, then the error itself. The error's
  // issue and these log lines share one trace id.
  app.get("/checkout", (_req, res) => {
    bb.log.info("checkout started", { cartItems: 3 });
    try {
      throw new Error("payment gateway timed out after 5000ms");
    } catch (err) {
      bb.log.error("payment failed", {
        reason: err instanceof Error ? err.message : String(err),
        // sensitive keys are redacted before leaving the process:
        password: "not-a-real-password",
      });
      bb.captureException(err);
      res.status(502).send("payment failed");
    }
  });

  app.get("/throw", (_req, res) => {
    try {
      throw new Error("simulated PaymentTimeout for manual testing");
    } catch (err) {
      client.captureException(err);
      res.status(500).send("captured and reported");
    }
  });

  app.get("/throw-slow", (_req, res) => {
    const start = Date.now();
    setTimeout(() => {
      try {
        throw new Error("simulated slow request timeout");
      } catch (err) {
        client.captureException(err, { release: "1.0.0" });
        res.status(500).send(`captured after ${Date.now() - start}ms`);
      }
    }, 50);
  });

  return { app, bb };
}

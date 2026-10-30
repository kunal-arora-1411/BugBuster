import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./openapi.js";

/**
 * Writes the committed copy of the API description to docs/openapi.json (for Postman, client
 * generators, and reading on GitHub). The running backend serves the same document itself at
 * GET /openapi.json. test/unit/openapi.test.ts fails when the committed copy is stale.
 *
 * Usage: pnpm --filter @bugbusterhq/backend openapi   (after `pnpm build`)
 */
const target = fileURLToPath(new URL("../../../docs/openapi.json", import.meta.url));
writeFileSync(target, JSON.stringify(buildOpenApiDocument(), null, 2) + "\n");
console.log(`Wrote ${target}`);

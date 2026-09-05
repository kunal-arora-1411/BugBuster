import { ControlDb } from "./db/control.js";

/**
 * Admin CLI — creates one org in the control database. There is no HTTP endpoint for this yet
 * (see docs/api.md's "Not yet built"); at pilot scale (a handful of orgs, created rarely), a CLI
 * run by whoever's operating the backend is the honest v1 answer, not a speculative admin API.
 *
 * Usage: node dist/create-org-cli.js <orgId> <name> <dbName> <apiKey> [controlDbUri]
 */
async function main() {
  const [orgId, name, dbName, apiKey, controlDbUri] = process.argv.slice(2);
  if (!orgId || !name || !dbName || !apiKey) {
    console.error("Usage: create-org-cli <orgId> <name> <dbName> <apiKey> [controlDbUri]");
    process.exit(1);
  }

  const controlDb = new ControlDb(
    controlDbUri ?? process.env.BUGBUSTER_CONTROL_DB_URI ?? "mongodb://localhost:27017",
  );
  await controlDb.connect();
  await controlDb.createOrg({ orgId, name, dbName, apiKey });
  await controlDb.close();
  console.log(`Created org "${name}" (${orgId}) -> database "${dbName}"`);
}

void main();

import { ControlDb } from "./db/control.js";

/**
 * Admin CLI — creates one org in the control database, with a caller-chosen dbName and API key.
 * Needs direct database access but no admin token. The HTTP equivalent is `POST /admin/orgs`
 * (enabled by BUGBUSTER_ADMIN_TOKEN), which derives the dbName and generates the key itself.
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

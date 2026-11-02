import { ControlDb } from "./db/control.js";
import { countUnreferencedEvents, deleteUnreferencedEvents } from "./db/maintenance.js";

/**
 * Operator CLI: deletes stored exemplars that no issue references, in every org's database.
 * Older backends stored every exemplar the SDK sent although an issue keeps at most six, so the
 * `events` collection grew forever; current backends no longer write them. Run once after
 * upgrading (re-running is harmless). `--dry-run` only counts.
 *
 * Usage: node dist/cleanup-events-cli.js [--dry-run] [controlDbUri]
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uri =
    args.find((a) => !a.startsWith("--")) ??
    process.env.BUGBUSTER_CONTROL_DB_URI ??
    "mongodb://localhost:27017";

  const controlDb = new ControlDb(uri);
  await controlDb.connect();
  let total = 0;
  try {
    for (const org of await controlDb.listOrgs()) {
      const db = controlDb.getClient().db(org.dbName);
      const n = dryRun ? await countUnreferencedEvents(db) : await deleteUnreferencedEvents(db);
      total += n;
      console.log(
        `${org.orgId} (${org.dbName}): ${n} unreferenced event(s) ${dryRun ? "found" : "deleted"}`,
      );
    }
    console.log(`Total: ${total} ${dryRun ? "would be deleted (dry run)" : "deleted"}`);
  } finally {
    await controlDb.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

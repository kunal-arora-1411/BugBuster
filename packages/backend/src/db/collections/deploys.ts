import type { Collection, Db } from "mongodb";

/** Releases + commit SHAs — the raw material for git correlation (doc.md §8). */
export interface Deploy {
  version: string;
  commitSha: string;
  deployedAt: string;
}

function deploysCollection(db: Db): Collection<Deploy> {
  return db.collection<Deploy>("deploys");
}

export async function ensureDeploysIndexes(db: Db): Promise<void> {
  await deploysCollection(db).createIndex({ version: 1 }, { unique: true });
}

export async function recordDeploy(db: Db, deploy: Deploy): Promise<void> {
  await deploysCollection(db).updateOne(
    { version: deploy.version },
    { $setOnInsert: deploy },
    { upsert: true },
  );
}

export async function getDeploy(db: Db, version: string): Promise<Deploy | undefined> {
  const doc = await deploysCollection(db).findOne({ version });
  return doc ?? undefined;
}

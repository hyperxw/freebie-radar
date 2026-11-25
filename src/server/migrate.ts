import { migrate, dbPath } from "./db.ts";
import { backfillXhsAndExpiry, ensureSources } from "./collectors/index.ts";

const version = migrate();
ensureSources();
const bf = backfillXhsAndExpiry();
console.log(`[migrate] schema v${version} ready at ${dbPath()} (backfill: xhs=${bf.xhsBackfilled}, exp=${bf.expiryUpdated})`);

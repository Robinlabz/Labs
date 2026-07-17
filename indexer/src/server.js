// Boots the indexer loop and the API together. Flags:
//   --no-api     run only the indexer (writer)
//   --no-index   run only the API (reader — e.g. a separate read replica)
//   --once       run a single backfill pass, then exit (for cron / CI)
import { CFG } from "./config.js";
import { runLoop, tick } from "./indexer.js";
import { startApi } from "./api.js";

const args = new Set(process.argv.slice(2));
const noApi = args.has("--no-api");
const noIndex = args.has("--no-index");
const once = args.has("--once");

console.log("── Robin Labs Pad indexer ──");
console.log(`db=${CFG.dbPath}`);

if (once) {
  const n = await tick();
  console.log(`[backfill] applied ${n} logs; cursor now up to date. exiting.`);
  process.exit(0);
}

if (!noApi) startApi();
if (!noIndex) runLoop();
else console.log("[indexer] disabled (--no-index); serving API only");

// Graceful shutdown so SQLite WAL checkpoints cleanly.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { console.log(`\n${sig} — bye`); process.exit(0); });
}

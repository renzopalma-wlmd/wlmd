#!/usr/bin/env node
//
// One-off / cron ClickUp sync.
//
//   npm run sync:clickup                  # syncs CLICKUP_SPACE_IDS
//   npm run sync:clickup -- 90111521965   # syncs specific space ids
//
require('dotenv').config();

const config = require('../src/config');
const { syncSpace } = require('../src/clickup/sync');
const logger = require('../src/utils/logger');

async function main() {
  const spaceIds = process.argv.slice(2).length ? process.argv.slice(2) : config.clickup.spaceIds;

  if (!config.clickup.apiToken) {
    console.error('\n❌ CLICKUP_API_TOKEN is not set.');
    console.error('   Get one from ClickUp → Settings → Apps → API Token (starts with pk_)');
    console.error('   then add it to .env and to Railway.\n');
    process.exit(1);
  }
  if (spaceIds.length === 0) {
    console.error('\n❌ No spaces to sync. Set CLICKUP_SPACE_IDS or pass ids as arguments.\n');
    process.exit(1);
  }

  const totals = { fetched: 0, inserted: 0, skipped: 0, duplicates: 0, failed: 0 };

  for (const spaceId of spaceIds) {
    const results = await syncSpace(spaceId);
    console.log(`\nSpace ${spaceId}`);
    console.log('  list                                    fetched  indexed  dupes  skipped  failed');
    for (const r of results) {
      console.log(
        `  ${r.list.slice(0, 38).padEnd(38)} ${String(r.fetched).padStart(7)} ${String(r.inserted).padStart(8)} ${String(r.duplicates).padStart(6)} ${String(r.skipped).padStart(8)} ${String(r.failed).padStart(7)}`
      );
      totals.fetched += r.fetched;
      totals.inserted += r.inserted;
      totals.skipped += r.skipped;
      totals.duplicates += r.duplicates;
      totals.failed += r.failed;
    }
  }

  console.log(
    `\nTotal: ${totals.fetched} fetched → ${totals.inserted} indexed ` +
      `(${totals.duplicates} duplicates collapsed, ${totals.skipped} skipped, ${totals.failed} failed)\n`
  );

  if (totals.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  logger.error('ClickUp sync failed', { error: error.message });
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});

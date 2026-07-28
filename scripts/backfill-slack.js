#!/usr/bin/env node
//
// Backfill Slack history into knowledge_context.
//
//   npm run backfill:slack                 # dry run, 30 days — writes nothing
//   npm run backfill:slack -- --days 7     # dry run, 7 days
//   npm run backfill:slack -- --write      # actually index
//
// Dry run is the default on purpose: this writes one embedding per message.
//
require('dotenv').config();

const { backfillChannel, listChannels, getBotUserId } = require('../src/slack/backfill');

function parseArgs(argv) {
  const days = Number.parseInt((argv[argv.indexOf('--days') + 1] || '').trim(), 10);
  return {
    days: argv.includes('--days') && Number.isFinite(days) && days > 0 ? days : 30,
    write: argv.includes('--write'),
  };
}

async function main() {
  const { days, write } = parseArgs(process.argv.slice(2));
  const oldest = Math.floor(Date.now() / 1000) - days * 86400;

  const [botUserId, channels] = await Promise.all([getBotUserId(), listChannels()]);

  console.log(
    `\n${write ? 'INDEXING' : 'DRY RUN'} — last ${days} days across ${channels.length} channels` +
      `${write ? '' : ' (nothing will be written)'}\n`
  );
  console.log('  channel                          scanned  threads  indexable  already  indexed  failed');

  const totals = { scanned: 0, threads: 0, indexable: 0, alreadyIndexed: 0, inserted: 0, failed: 0 };

  for (const channel of channels) {
    try {
      const s = await backfillChannel(channel.id, { oldest, botUserId, dryRun: !write });
      for (const key of Object.keys(totals)) totals[key] += s[key];
      console.log(
        `  ${('#' + channel.name).slice(0, 30).padEnd(30)} ${String(s.scanned).padStart(9)} ${String(s.threads).padStart(8)} ${String(s.indexable).padStart(10)} ${String(s.alreadyIndexed).padStart(8)} ${String(s.inserted).padStart(8)} ${String(s.failed).padStart(7)}`
      );
    } catch (error) {
      console.log(`  ${('#' + channel.name).slice(0, 30).padEnd(30)} ERROR: ${error.message}`);
    }
  }

  const toWrite = totals.indexable - totals.alreadyIndexed;
  console.log(
    `\n  TOTAL${''.padEnd(25)} ${String(totals.scanned).padStart(9)} ${String(totals.threads).padStart(8)} ${String(totals.indexable).padStart(10)} ${String(totals.alreadyIndexed).padStart(8)} ${String(totals.inserted).padStart(8)} ${String(totals.failed).padStart(7)}`
  );

  if (!write) {
    console.log(`\n  ${toWrite} messages would be indexed (${toWrite} embedding calls).`);
    console.log('  Re-run with --write to do it.\n');
  } else {
    console.log(`\n  Indexed ${totals.inserted} messages, ${totals.failed} failed.\n`);
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});

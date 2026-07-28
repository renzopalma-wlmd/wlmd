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
  const num = (flag, fallback) => {
    const v = Number.parseInt((argv[argv.indexOf(flag) + 1] || '').trim(), 10);
    return argv.includes(flag) && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const only = argv.includes('--channels')
    ? (argv[argv.indexOf('--channels') + 1] || '').split(',').map((c) => c.trim().replace(/^#/, '')).filter(Boolean)
    : [];
  return {
    days: num('--days', 30),
    // A daily embedding allowance is finite, so a run must be able to stop on
    // purpose rather than die partway through with a quota error.
    max: num('--max', Infinity),
    only,
    write: argv.includes('--write'),
  };
}

async function main() {
  const { days, write, max, only } = parseArgs(process.argv.slice(2));
  const oldest = Math.floor(Date.now() / 1000) - days * 86400;

  const [botUserId, allChannels] = await Promise.all([getBotUserId(), listChannels()]);
  const channels = only.length
    ? allChannels.filter((c) => only.some((o) => c.name === o || c.id === o))
    : allChannels;

  if (only.length && channels.length === 0) {
    console.error(`\n❌ No channels matched: ${only.join(', ')}\n`);
    process.exit(1);
  }

  console.log(
    `\n${write ? 'INDEXING' : 'DRY RUN'} — last ${days} days across ${channels.length} channel(s)` +
      (Number.isFinite(max) ? `, stopping after ${max} messages` : '') +
      `${write ? '' : ' (nothing will be written)'}\n`
  );
  console.log('  channel                          scanned  threads  indexable  already  indexed  failed');

  const totals = { scanned: 0, threads: 0, indexable: 0, alreadyIndexed: 0, inserted: 0, failed: 0 };

  let budget = max;
  for (const channel of channels) {
    if (write && budget <= 0) {
      console.log(`  ${('#' + channel.name).slice(0, 30).padEnd(30)} skipped — budget reached`);
      continue;
    }
    try {
      const s = await backfillChannel(channel.id, { oldest, botUserId, dryRun: !write, limit: budget });
      budget -= s.inserted;
      for (const key of Object.keys(totals)) totals[key] += s[key];
      console.log(
        `  ${('#' + channel.name).slice(0, 30).padEnd(30)} ${String(s.scanned).padStart(9)} ${String(s.threads).padStart(8)} ${String(s.indexable).padStart(10)} ${String(s.alreadyIndexed).padStart(8)} ${String(s.inserted).padStart(8)} ${String(s.failed).padStart(7)}`
      );
    } catch (error) {
      console.log(`  ${('#' + channel.name).slice(0, 30).padEnd(30)} ERROR: ${error.message}`);
      // A daily-quota error means every remaining channel will fail too.
      if (error.dailyQuotaExhausted) {
        console.log('\n  Daily embedding quota exhausted — stopping. Re-run tomorrow or enable billing.');
        break;
      }
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

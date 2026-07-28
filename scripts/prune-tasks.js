#!/usr/bin/env node
//
// Drop ClickUp tasks completed longer ago than the retention window.
//
//   npm run prune:tasks              # dry run — writes nothing
//   npm run prune:tasks -- --write   # actually delete
//   npm run prune:tasks -- --days 90 --write
//
// The sync already enforces the window on every run; this exists so the window
// still advances when nothing has triggered a sync, and so it can be scheduled
// independently.
//
require('dotenv').config();

const config = require('../src/config');
const { supabase } = require('../src/supabase');

// Statuses that mean "this work is finished". ClickUp lets each list define its
// own, so match on the ones actually present in this workspace.
const DONE_STATUSES = new Set(['complete', 'completed', 'closed', 'done', 'cancelled', 'canceled']);

async function main() {
  const argv = process.argv.slice(2);
  const daysArg = Number.parseInt((argv[argv.indexOf('--days') + 1] || '').trim(), 10);
  const days = argv.includes('--days') && Number.isFinite(daysArg) && daysArg > 0 ? daysArg : config.clickup.retentionDays;
  const write = argv.includes('--write');
  const cutoff = Date.now() - days * 86400000;

  const { data, error } = await supabase
    .from('knowledge_context')
    .select('id, content, metadata')
    .eq('source', 'clickup');
  if (error) throw error;

  const stale = data.filter((row) => {
    const status = String(row.metadata?.status || '').toLowerCase();
    if (!DONE_STATUSES.has(status)) return false;
    const closed = Number(row.metadata?.date_closed);
    // No close date recorded: fall back to the due date, and keep it if neither
    // is known rather than deleting on a guess.
    const when = Number.isFinite(closed) && closed > 0 ? closed : Number(row.metadata?.due_date);
    return Number.isFinite(when) && when > 0 && when < cutoff;
  });

  console.log(
    `\n${write ? 'PRUNING' : 'DRY RUN'} — completed tasks closed more than ${days} days ago` +
      `${write ? '' : ' (nothing will be deleted)'}\n`
  );
  console.log(`  clickup rows:      ${data.length}`);
  console.log(`  eligible to drop:  ${stale.length}`);

  const byBoard = {};
  for (const row of stale) {
    const board = row.metadata?.list_name || row.external_id || '?';
    byBoard[board] = (byBoard[board] || 0) + 1;
  }
  for (const [board, n] of Object.entries(byBoard)) console.log(`    ${board.padEnd(22)} ${n}`);

  for (const row of stale.slice(0, 5)) {
    console.log(`    e.g. ${row.content.split('\n')[0].slice(0, 62)}`);
  }

  if (!write) {
    console.log('\n  Re-run with --write to delete.\n');
    return;
  }
  if (stale.length === 0) {
    console.log('\n  Nothing to prune.\n');
    return;
  }

  // Chunked so a large prune doesn't build one enormous IN clause.
  let deleted = 0;
  for (let i = 0; i < stale.length; i += 200) {
    const ids = stale.slice(i, i + 200).map((r) => r.id);
    const { error: delError } = await supabase.from('knowledge_context').delete().in('id', ids);
    if (delError) throw delError;
    deleted += ids.length;
  }
  console.log(`\n  Deleted ${deleted} rows.\n`);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});

/**
 * calibrate.ts — §11 step 1. Full sitemap walk, gates on, vision off, no email.
 *
 * Reports total lots, survivors after the year gate, survivors after the
 * target-model gate, and the share with `clean_title: true`.
 *
 * This determines whether the rest is worth building. If clean-title inventory
 * in the target models is negligible, stop and revisit §10 before writing
 * anything else — do not tune the gates to increase the count.
 *
 *   npm run calibrate -- --renders=400
 */
import { MIN_MODEL_YEAR, TARGET_MODELS } from './config.js';
import { finishRun, startRun } from './db.js';
import { Fetcher } from './fetcher.js';
import { gate, preGate } from './gates.js';
import { diffSitemap } from './sitemap.js';
import { fleetReadyValue } from './scoring.js';
import type { LotRef } from './types.js';
import * as ui from './ui.js';

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Even spacing across the survivor list, so one make cannot dominate the sample. */
function sample<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const stride = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * stride)] as T);
}

async function calibrate(): Promise<void> {
  const renderBudget = arg('renders', 400);
  const runId = startRun('calibrate');
  ui.banner('Calibration crawl', 'gates on · vision off · no email');

  const walk = new ui.Progress('sitemap');
  const diff = await diffSitemap({ onProgress: (seen) => walk.update(seen, seen, 'lots indexed') });
  walk.done(`${diff.all.length} lots indexed`);

  const afterYear = diff.all.filter((l) => Number.isFinite(l.year) && l.year >= MIN_MODEL_YEAR);
  const afterModel = diff.all.filter(preGate);

  // Which target models actually appear — this is the list §11 step 2 should
  // build FLEET_READY_VALUES for, rather than the aspirational one.
  const byKey = new Map<string, LotRef[]>();
  for (const l of afterModel) {
    const bucket = byKey.get(l.key);
    if (bucket) bucket.push(l);
    else byKey.set(l.key, [l]);
  }

  const toRender = sample(afterModel, renderBudget);
  ui.step('Sampling', `${toRender.length} of ${afterModel.length} survivors for title inspection`);

  const fetcher = new Fetcher();
  await fetcher.open();
  const bar = new ui.Progress('render');
  const vehicles = await fetcher.fetchMany(toRender, (_v, _r, done) =>
    bar.update(done, toRender.length, 'detail pages'),
  );
  bar.done(`${vehicles.length}/${toRender.length} payloads captured`);
  await fetcher.close();

  const cleanTitle = vehicles.filter((v) => v.cleanTitle === true).length;
  const salvage = vehicles.filter((v) => v.cleanTitle === false).length;
  const absent = vehicles.filter((v) => v.cleanTitle === undefined).length;
  const gates = vehicles.map(gate);
  const passed = gates.filter((g) => g.verdict === 'pass').length;
  const unverified = gates.filter((g) => g.verdict === 'unverified').length;

  ui.funnel([
    { label: 'sitemap', n: diff.all.length },
    { label: `year >= ${MIN_MODEL_YEAR}`, n: afterYear.length },
    { label: 'target models', n: afterModel.length },
    { label: 'sampled', n: vehicles.length },
    { label: 'clean title', n: cleanTitle },
    { label: 'gate passed', n: passed },
  ]);

  const share = vehicles.length ? cleanTitle / vehicles.length : 0;
  ui.summary([
    ['lots indexed', String(diff.all.length)],
    [`survivors after year gate (>= ${MIN_MODEL_YEAR})`, String(afterYear.length)],
    [`survivors after target-model gate (${TARGET_MODELS.size} models)`, String(afterModel.length)],
    ['sampled for title inspection', String(vehicles.length)],
    ['clean_title: true', `${cleanTitle}  (${(share * 100).toFixed(1)}%)`],
    ['clean_title: false', String(salvage)],
    ['clean_title absent', String(absent)],
    ['gate pass', String(passed)],
    ['gate unverified', String(unverified)],
  ]);

  // Make/model breakdown — the input to building the valuation table.
  const ranked = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20);
  if (ranked.length) {
    ui.step('Target models present in inventory', '(valuation table should cover these)');
    const width = Math.max(...ranked.map(([k]) => k.length));
    for (const [key, lots] of ranked) {
      const years = [...new Set(lots.map((l) => l.year))].sort();
      const covered = years.filter((y) => fleetReadyValue(key, y) !== null).length;
      const flag = covered === years.length ? ui.c.good('✓') : ui.c.warn('·');
      ui.note(
        `${flag} ${key.replace('|', ' ').padEnd(width)}  ${String(lots.length).padStart(4)} lots  ` +
          `years ${years.join(', ')}  valuation ${covered}/${years.length}`,
      );
    }
  }

  if (share < 0.05) {
    ui.warn(
      'Clean-title share in the target models is negligible. Stop here and revisit §10 ' +
        'before building anything further — Emirates Auction is the natural second source.',
    );
  } else {
    ui.ok(`Clean-title share ${(share * 100).toFixed(1)}% — proceed to §11 step 2 (FLEET_READY_VALUES).`);
  }

  finishRun(runId, {
    total: diff.all.length,
    afterYear: afterYear.length,
    afterModel: afterModel.length,
    sampled: vehicles.length,
    cleanTitle,
    salvage,
    absent,
    passed,
    unverified,
  });
}

calibrate().catch((err: unknown) => {
  ui.fail(`calibration failed: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});

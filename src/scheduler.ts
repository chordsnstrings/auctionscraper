/**
 * scheduler.ts — the App Platform worker entry point.
 *
 * App Platform has no cron primitive: jobs fire on deploy, not on a schedule.
 * So the worker is a long-lived process that sleeps until the next 06:00 Gulf
 * and runs the screen itself.
 *
 * Two deliberate choices:
 *
 *   • Preflight runs once at boot and its verdict is logged loudly. A host that
 *     Cloudflare refuses produces zero lots, which is indistinguishable from a
 *     quiet day at the auction unless something says so.
 *   • The screen is spawned as a child process rather than imported. A run that
 *     exhausts memory — Chromium peaks near 865 MB against this container's
 *     1 GB — kills the child and is reported; it does not take the scheduler
 *     down with it and silently stop every future run.
 */
import { spawn } from 'node:child_process';
import { DIGEST_TIMEZONE } from './config.js';
import { closeDb, migrate } from './db.js';

const RUN_HOUR = Number(process.env.RUN_HOUR ?? 6);

const log = (msg: string): void => console.log(`[scheduler ${new Date().toISOString()}] ${msg}`);

/** Milliseconds until the next RUN_HOUR in DIGEST_TIMEZONE, DST-safe. */
export function msUntilNextRun(now: Date = new Date(), hour: number = RUN_HOUR): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DIGEST_TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const secondsNow = get('hour') * 3600 + get('minute') * 60 + get('second');
  const target = hour * 3600;
  const delta = target - secondsNow;
  return (delta > 0 ? delta : delta + 86_400) * 1000;
}

function runScript(script: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    log(`starting: npm run ${script}`);
    const child = spawn('npm', ['run', script], { stdio: 'inherit', env: process.env });
    const timer = setTimeout(() => {
      log(`${script} exceeded ${timeoutMs}ms — killing`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      log(`${script} finished code=${code ?? 'null'} signal=${signal ?? 'none'}`);
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`${script} failed to start: ${err.message}`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  log(`worker starting · timezone=${DIGEST_TIMEZONE} · daily run at ${RUN_HOUR}:00`);

  try {
    await migrate();
    log('database migrated');
  } catch (err) {
    log(`FATAL: database unreachable — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  } finally {
    await closeDb();
  }

  const pre = await runScript('preflight', 10 * 60_000);
  if (pre !== 0) {
    log('PREFLIGHT FAILED — an empty digest from this host is a block, not a finding.');
    log('The schedule still runs so the failure is visible daily rather than silent.');
  }

  if (process.env.RUN_ON_BOOT === 'true') {
    await runScript('run', 90 * 60_000);
  }

  for (;;) {
    const wait = msUntilNextRun();
    const next = new Date(Date.now() + wait);
    log(`next run in ${(wait / 3_600_000).toFixed(2)}h at ${next.toISOString()}`);
    await new Promise((r) => setTimeout(r, wait));
    await runScript('run', 90 * 60_000);
    // Guard against a same-second wake looping the run twice.
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main().catch((err: unknown) => {
  log(`crashed: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});

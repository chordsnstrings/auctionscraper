/**
 * auth.ts — one-time interactive login (§8.3 route 1).
 *
 * Opens a headed browser, waits for a human to sign in with their own
 * registered bidder credentials, and persists `storageState` so the watcher
 * can reuse the session headlessly.
 *
 * No credentials are stored, read, or transmitted by this file (§13). It
 * persists a session only. `data/session.json` is gitignored and must be
 * treated as a secret.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { BROWSER_HEADERS, IGNORE_HTTPS_ERRORS, SESSION_STATE_PATH, SITE_ORIGIN } from './config.js';
import * as ui from './ui.js';

async function login(): Promise<void> {
  ui.banner('Interactive sign-in', 'one-time · your own credentials · session only');
  ui.note('A browser window will open. Sign in there, then return here and press Enter.');
  ui.note('Nothing you type in the browser is read, logged, or stored by this process.');

  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
    userAgent: BROWSER_HEADERS['User-Agent'],
    locale: 'en-GB',
    timezoneId: 'Asia/Dubai',
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(SITE_ORIGIN, { waitUntil: 'domcontentloaded' });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\n  Press Enter once you are signed in… ');
  rl.close();

  mkdirSync(dirname(SESSION_STATE_PATH), { recursive: true });
  await context.storageState({ path: SESSION_STATE_PATH });
  await browser.close();

  ui.ok(`session saved to ${SESSION_STATE_PATH}`);
  ui.warn('Treat that file as a secret. It is gitignored; keep it off shared drives.');
  ui.note('Refresh it before the auction window, not reactively on failure (§8.5).');
}

login().catch((err: unknown) => {
  ui.fail(`login failed: ${(err as Error).message}`);
  process.exitCode = 1;
});

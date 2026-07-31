/**
 * responsive.ts — renders the digest in a real browser and asserts it never
 * forces a horizontal scrollbar.
 *
 *   npm run check:responsive
 *
 * This exists because the failure mode is invisible to eyeballing: a single
 * `white-space: nowrap` table row deep inside a component sets a min-content
 * width that propagates all the way up and puts a hard floor under the whole
 * email. A full-page screenshot expands to fit the content and looks perfect
 * while every phone in the world gets a sideways scroll.
 *
 * verify.ts cannot catch this — it needs layout, which needs a browser.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { BROWSER_LAUNCH_ARGS } from './config.js';
import * as ui from './ui.js';

/** iPhone SE through to the design width. */
const WIDTHS = [320, 360, 375, 414, 480, 600, 700];
const PAGES = ['preview/sample.html', 'preview/empty.html'];

/**
 * Honour a pre-provisioned browser when one is present, so CI images that ship
 * Chromium do not have to re-download it.
 */
function launchOptions(): { executablePath?: string; args: string[] } {
  const pinned = process.env.CHROMIUM_PATH;
  const args = [...BROWSER_LAUNCH_ARGS];
  if (pinned && existsSync(pinned)) return { executablePath: pinned, args };
  return { args };
}

interface Offender {
  tag: string;
  width: number;
  text: string;
}

async function widestComponent(page: import('playwright').Page): Promise<Offender | null> {
  return page.evaluate(() => {
    // Clone each table into a min-content probe: the one whose intrinsic width
    // is largest is what is holding the page open.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:min-content;';
    document.body.appendChild(probe);
    let worst: { tag: string; width: number; text: string } | null = null;
    for (const t of Array.from(document.querySelectorAll('table, div'))) {
      if (t.children.length === 0) continue;
      probe.innerHTML = '';
      probe.appendChild(t.cloneNode(true));
      const el = probe.firstElementChild;
      if (!el) continue;
      const width = Math.round(el.getBoundingClientRect().width);
      if (!worst || width > worst.width) {
        worst = {
          tag: t.tagName + (t.className ? `.${String(t.className).split(' ')[0]}` : ''),
          width,
          text: (t.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        };
      }
    }
    probe.remove();
    return worst;
  });
}

async function main(): Promise<void> {
  ui.banner('Responsive check', 'no horizontal overflow at any phone width');

  for (const page of PAGES) {
    if (!existsSync(page)) {
      ui.fail(`${page} missing — run "npm run preview" first.`);
      process.exitCode = 1;
      return;
    }
  }

  let browser: Browser;
  try {
    browser = await chromium.launch(launchOptions());
  } catch (err) {
    ui.warn(`could not launch chromium: ${(err as Error).message.split('\n')[0]}`);
    ui.note('Run "npx playwright install chromium", or set CHROMIUM_PATH to an existing binary.');
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  try {
    for (const file of PAGES) {
      for (const width of WIDTHS) {
        const p = await browser.newPage({ viewport: { width, height: 900 } });
        await p.goto(`file://${process.cwd()}/${file}`);
        // Animations use transforms, which do not affect layout — but let the
        // page settle so nothing is measured mid-paint.
        await p.waitForTimeout(400);

        const { scrollW, clientW } = await p.evaluate(() => ({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
        }));

        if (scrollW > clientW) {
          failures += 1;
          const worst = await widestComponent(p);
          ui.fail(
            `${file} @ ${width}px — overflows by ${scrollW - clientW}px` +
              (worst ? ` (widest component ${worst.tag} needs ${worst.width}px: "${worst.text}")` : ''),
          );
        } else {
          ui.note(`${ui.c.good('✓')} ${file.padEnd(20)} @ ${String(width).padStart(4)}px`);
        }
        await p.close();
      }
    }
  } finally {
    await browser.close();
  }

  ui.summary([
    ['widths checked', String(WIDTHS.length * PAGES.length)],
    ['overflowing', String(failures)],
  ]);

  if (failures > 0) process.exitCode = 1;
  else ui.ok('the digest reflows cleanly from 320px up');
}

main().catch((err: unknown) => {
  ui.fail(`responsive check failed: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});

/**
 * ui.ts — terminal presentation.
 *
 * The digest is the product; this is the operator's view of the run. It uses
 * the same navy/gold vocabulary so the two read as one system. Everything
 * degrades to plain text when stdout is not a TTY, when NO_COLOR is set, or
 * when the run is piped into logs/run.log by cron — which is the normal case.
 */
const stream = process.stdout;

const COLOUR =
  !process.env.NO_COLOR &&
  process.env.FORCE_COLOR !== '0' &&
  (stream.isTTY === true || process.env.FORCE_COLOR === '1');

const TRUECOLOR = COLOUR && /truecolor|24bit/i.test(process.env.COLORTERM ?? '');

const rgb = (r: number, g: number, b: number) => (s: string): string => {
  if (!COLOUR) return s;
  if (!TRUECOLOR) return s;
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
};

const sgr = (code: string) => (s: string): string => (COLOUR ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  gold: rgb(201, 168, 76),
  goldDeep: rgb(168, 135, 58),
  navy: rgb(90, 122, 158),
  text: rgb(226, 224, 218),
  muted: rgb(122, 134, 149),
  good: rgb(96, 165, 122),
  warn: rgb(198, 150, 63),
  bad: rgb(196, 91, 84),
  bold: sgr('1'),
  dim: sgr('2'),
} as const;

const BAR_FULL = '█';
const BAR_EMPTY = '░';

export function rule(width = 62): string {
  return c.dim(c.gold('─'.repeat(width)));
}

export function banner(title: string, subtitle: string): void {
  const w = 62;
  stream.write('\n');
  stream.write(`  ${c.bold(c.gold('ECOSINE'))} ${c.dim(c.muted('· auction intelligence'))}\n`);
  stream.write(`  ${c.bold(c.text(title))}\n`);
  stream.write(`  ${c.muted(subtitle)}\n`);
  stream.write(`  ${rule(w)}\n\n`);
}

export function step(label: string, detail = ''): void {
  stream.write(`  ${c.gold('▸')} ${c.text(label)}${detail ? ` ${c.muted(detail)}` : ''}\n`);
}

export function note(text: string): void {
  stream.write(`    ${c.muted(text)}\n`);
}

export function warn(text: string): void {
  stream.write(`  ${c.warn('!')} ${c.warn(text)}\n`);
}

export function fail(text: string): void {
  stream.write(`  ${c.bad('✕')} ${c.bad(text)}\n`);
}

export function ok(text: string): void {
  stream.write(`  ${c.good('✓')} ${c.text(text)}\n`);
}

/** A single line that rewrites in place on a TTY, and appends when piped. */
export class Progress {
  private last = '';
  private frame = 0;
  private static readonly SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(private readonly label: string) {}

  update(done: number, total: number, detail = ''): void {
    const pct = total > 0 ? done / total : 0;
    const width = 22;
    const filled = Math.round(pct * width);
    const bar = c.gold(BAR_FULL.repeat(filled)) + c.dim(c.muted(BAR_EMPTY.repeat(width - filled)));
    const spin = c.gold(Progress.SPIN[this.frame++ % Progress.SPIN.length] as string);
    const line = `  ${spin} ${c.text(this.label)} ${bar} ${c.muted(`${done}/${total}`)} ${c.dim(c.muted(detail))}`;

    if (stream.isTTY) {
      stream.write(`\r\x1b[2K${line}`);
    } else if (done === total || done % 25 === 0) {
      stream.write(`  ${this.label} ${done}/${total} ${detail}\n`);
    }
    this.last = line;
  }

  done(summary: string): void {
    if (stream.isTTY) stream.write(`\r\x1b[2K`);
    ok(`${this.label} — ${summary}`);
    void this.last;
  }
}

/** The §3 funnel, drawn. Thousands → tens should be visible at a glance. */
export function funnel(rows: readonly { label: string; n: number }[]): void {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  stream.write('\n');
  for (const [i, r] of rows.entries()) {
    const width = 30;
    const filled = Math.max(r.n > 0 ? 1 : 0, Math.round((r.n / max) * width));
    const last = i === rows.length - 1;
    const bar = (last ? c.gold : c.navy)(BAR_FULL.repeat(filled)) + c.dim(c.muted(BAR_EMPTY.repeat(width - filled)));
    stream.write(
      `    ${c.muted(r.label.padEnd(labelWidth))}  ${bar}  ${(last ? c.gold : c.text)(String(r.n).padStart(6))}\n`,
    );
  }
  stream.write('\n');
}

/** Closing summary. Values are right-aligned so the numbers form a column. */
export function summary(rows: readonly [string, string][]): void {
  const w = Math.max(...rows.map((r) => r[0].length));
  stream.write(`  ${rule()}\n`);
  for (const [k, v] of rows) {
    stream.write(`  ${c.muted(k.padEnd(w))}   ${c.text(v)}\n`);
  }
  stream.write(`  ${rule()}\n\n`);
}

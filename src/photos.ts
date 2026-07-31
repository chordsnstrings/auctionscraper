/**
 * photos.ts — turn a lot's photo URLs into inline image data.
 *
 * Why this exists rather than handing the URL to the model: a provider that
 * fetches an image URL does so from its own egress, and Al Qaryah's images sit
 * behind the same Cloudflare tenancy that already refuses this container's
 * plain `fetch` (see preflight). A stranger's datacenter IP will not be scored
 * any better than ours. Downloading the bytes here — ideally through the
 * browser context that already holds the clearance cookie — makes the vision
 * stage independent of whether anyone else can reach the CDN at all.
 *
 * The failure mode this deliberately avoids: silently assessing a lot on fewer
 * photos than were available. Callers get the count that actually loaded and
 * `assess()` records it, so a thin assessment is visible as a thin assessment.
 */
import { PHOTO_MAX_BYTES, PHOTO_TIMEOUT_MS, BROWSER_HEADERS, SITE_ORIGIN } from './config.js';

export interface InlinePhoto {
  /** The source URL, kept so a bad assessment can be traced to its inputs. */
  url: string;
  /** `data:<mime>;base64,…` — what the provider is actually shown. */
  dataUrl: string;
  bytes: number;
  mime: string;
}

/** Resolves one photo URL to inline bytes, or null if it cannot be had. */
export type PhotoLoader = (url: string) => Promise<InlinePhoto | null>;

/** Response shape common to plain `fetch` and a browser navigation. */
export interface BytesResponse {
  ok: boolean;
  body: Buffer;
}

/** Reads a URL's raw bytes. The browser supplies one; plain HTTP is the other. */
export type BytesReader = (url: string) => Promise<BytesResponse | null>;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Magic-byte sniff, and deliberately nothing else.
 *
 * The obvious alternative — trust `Content-Type` when the bytes are not
 * recognised — is what lets a Cloudflare challenge page or an error JSON get
 * base64'd and shown to the model as though it were a photograph of a car. Every
 * format worth sending has a magic number, so an unrecognised body is not an
 * image we should be paying to assess, whatever the header claims.
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  return null;
}

function toInline(url: string, res: BytesResponse): InlinePhoto | null {
  if (!res.ok || res.body.length === 0 || res.body.length > PHOTO_MAX_BYTES) return null;
  const mime = sniffMime(res.body);
  if (!mime) return null;
  return {
    url,
    dataUrl: `data:${mime};base64,${res.body.toString('base64')}`,
    bytes: res.body.length,
    mime,
  };
}

/** Photo requests are image requests, not navigations — headers say so. */
const IMAGE_HEADERS: Record<string, string> = {
  ...BROWSER_HEADERS,
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
  Referer: `${SITE_ORIGIN}/`,
};
delete IMAGE_HEADERS['Sec-Fetch-User'];
delete IMAGE_HEADERS['Upgrade-Insecure-Requests'];
// Node's fetch decompresses transparently; asking for br on a JPEG only risks
// a body we then have to undo by hand.
delete IMAGE_HEADERS['Accept-Encoding'];

/** Plain HTTP. Works for an unprotected CDN; the fallback everywhere else. */
export const httpPhotoLoader: PhotoLoader = async (url) => {
  try {
    const res = await fetch(url, {
      headers: IMAGE_HEADERS,
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
    });
    const body = Buffer.from(await res.arrayBuffer());
    return toInline(url, { ok: res.ok, body });
  } catch {
    return null;
  }
};

/**
 * Load photos through the browser, falling back to plain HTTP per image.
 *
 * The browser reader wins because it is Chromium's own network stack: the same
 * TLS and HTTP/2 fingerprint that gets 200s on the detail pages, rather than
 * Node's, which Cloudflare scores like any other script. One refused image
 * should never cost the whole lot, hence the fallback.
 */
export function browserPhotoLoader(read: BytesReader): PhotoLoader {
  return async (url) => {
    try {
      const res = await read(url);
      if (res) {
        const inline = toInline(url, res);
        if (inline) return inline;
      }
    } catch {
      /* fall through */
    }
    return httpPhotoLoader(url);
  };
}

/**
 * Load a set of photos, preserving order and dropping failures.
 *
 * Order matters: normalise.ts sorts the default/inventory image first, and the
 * first photo is the one the model anchors on. Concurrency is deliberately low
 * — each browser-backed load is a page, and this container has 1 GB against a
 * Chromium that already peaks near 865 MB during a render.
 */
export async function loadPhotos(
  urls: readonly string[],
  loader: PhotoLoader,
  concurrency = 2,
): Promise<InlinePhoto[]> {
  const out: (InlinePhoto | null)[] = new Array(urls.length).fill(null);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const url = urls[i];
      if (url === undefined) return;
      out[i] = await loader(url).catch(() => null);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out.filter((p): p is InlinePhoto => p !== null);
}

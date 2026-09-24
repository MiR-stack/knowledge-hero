import dns from 'node:dns/promises';
import net from 'node:net';
import { chromium } from 'playwright';
import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';

export class SSRFBlockedError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SSRFBlockedError'; }
}

// Returns true if the IP is in a blocked range
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;                              // RFC 1918 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;      // RFC 1918 172.16-31/12
    if (a === 192 && b === 168) return true;                // RFC 1918 192.168/16
    if (a === 169 && b === 254) return true;                // Link-local
    if (a === 127) return true;                             // Loopback
    if (a === 0) return true;                              // This network
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT (RFC 6598)
    if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol
    if (a === 198 && (b === 18 || b === 19)) return true;  // Benchmark
    if (a === 240) return true;                            // Reserved
    if (ip === '255.255.255.255') return true;             // Broadcast
  }
  if (net.isIPv6(ip)) {
    if (ip === '::1') return true;                  // Loopback
    const lower = ip.toLowerCase();
    if (lower.startsWith('fe80:')) return true;     // Link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower === '::') return true;                // Unspecified
    if (lower.startsWith('2001:db8:')) return true; // Documentation
  }
  return false;
}

export async function checkHostForSSRF(hostname: string): Promise<void> {
  // Reject IP literals directly
  if (net.isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new SSRFBlockedError(`SSRF blocked: IP literal ${hostname} is in a blocked range`);
    }
    return;
  }
  // Resolve hostname and check all returned IPs
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true }) as Array<{ address: string; family: number }>;
  } catch (e) {
    throw new SSRFBlockedError(`SSRF blocked: cannot resolve hostname ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new SSRFBlockedError(
        `SSRF blocked: ${hostname} resolves to blocked IP ${address}`
      );
    }
  }
}

export interface WebUrlResult {
  url: string;
  title: string;
  text: string;
  screenshotS3Key: string | null;
  extractionFailed: boolean; // true if DOM cap exceeded, text from screenshot fallback
}

let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
      forcePathStyle: config.s3.forcePathStyle,
    });
  }
  return s3Client;
}

export async function fetchWebUrl(
  url: string,
  workspaceId: string,
  documentId: string
): Promise<WebUrlResult> {
  // Pre-flight check on initial URL
  const parsedUrl = new URL(url);
  await checkHostForSSRF(parsedUrl.hostname);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let screenshotS3Key: string | null = null;
  let extractionFailed = false;

  try {
    // Intercept EVERY request (including redirect hops) for SSRF re-validation
    await page.route('**', async (route) => {
      const reqUrl = route.request().url();
      try {
        const parsed = new URL(reqUrl);
        // Re-check hostname on every request (covers redirects and resource loads)
        await checkHostForSSRF(parsed.hostname);
        await route.continue();
      } catch (e) {
        // Abort the request — SSRF blocked
        await route.abort('accessdenied');
      }
    });

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: config.playwrightTimeoutMs,
    }).catch(() => 
      // Fallback: wait for load event
      page.waitForLoadState('load', { timeout: config.playwrightTimeoutMs })
    );

    // Take screenshot always (fallback citation source per FR-2.4)
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const s3Key = `${workspaceId}/${documentId}/screenshot.png`;
    await getS3().send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
      Body: screenshot,
      ContentType: 'image/png',
    }));
    screenshotS3Key = s3Key;

    const title = await page.title();
    const domContent = await page.content();

    if (domContent.length > config.webUrlMaxBytes) {
      // DOM cap exceeded — use screenshot fallback only
      return { url, title, text: '', screenshotS3Key, extractionFailed: true };
    }

    // Extract <main> or <article> or <body>, strip script/style
    // NOTE: this callback runs in the browser (Playwright serialises it),
    // so document/Element/HTMLElement are valid browser globals — not Node types.
    const text = await page.evaluate(/* @__PURE__ */ () => {
      /* eslint-disable */
      // This runs in the browser context (Playwright). Use globalThis to avoid
      // tsc complaining about browser-only globals like `window` and `document`.
      const root = globalThis as any;
      const doc = root.document;
      if (!doc) return '';
      const el: any =
        doc.querySelector('main') ||
        doc.querySelector('article') ||
        doc.body;
      if (!el) return '';
      el.querySelectorAll('script, style, noscript').forEach((n: any) => n.remove());
      return (el as any).innerText.trim();
      /* eslint-enable */
    });

    return { url, title, text, screenshotS3Key, extractionFailed: false };
  } finally {
    await browser.close();
  }
}

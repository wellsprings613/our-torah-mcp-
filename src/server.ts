import express, { Request, Response } from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import fetch, { RequestInit } from 'node-fetch';
import config from 'config';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import rateLimit from 'express-rate-limit';
import robotsParser from 'robots-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import pdfParse from 'pdf-parse';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';

// Simple TTL cache
type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<any>>();
const now = () => Date.now();
function getCache<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}
function setCache<T>(key: string, value: T, ttlMs = 5 * 60_000) {
  cache.set(key, { value, expiresAt: now() + ttlMs });
  // Simple LRU trim
  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

const server = new McpServer({ name: 'torah-mcp', version: '0.1.0' });
const sefariaSseTransports: Record<string, SSEServerTransport> = {};
const sefariaSseHeartbeats: Record<string, NodeJS.Timeout> = {};
// A separate MCP server exposing generic web search/fetch suitable for GPT connectors
const webServer = new McpServer(
  { name: 'open-deep-research-web', version: '0.1.0' },
  { capabilities: { logging: {} } }
);
const webSseTransports: Record<string, SSEServerTransport> = {};
const webSseHeartbeats: Record<string, NodeJS.Timeout> = {};

// Quick-win: common phrase → canonical ref mapping for sugyot
const SUGYA_ALIASES: Array<{ pattern: RegExp; ref: string }> = [
  { pattern: /(shabbat|sabbath).*?(candle|light)/i, ref: 'Shulchan Arukh, Orach Chayim 263' },
  { pattern: /(hanukkah|chanukah|חנוכה).*?(light|candle)/i, ref: 'Shulchan Arukh, Orach Chayim 671' },
  { pattern: /(lo\s*bashamayim\s*hi|לא\s*בשמים\s*היא)/i, ref: 'Bava Metzia 59b' },
  { pattern: /(pikuach\s*nefesh|saving\s*a\s*life|פיקוח\s*נפש)/i, ref: 'Yoma 85b' }
];

// Utilities
const normalizeRef = (ref: string) => ref.replace(/\s+/g, ' ').trim();
const flattenText = (value: any): string =>
  Array.isArray(value)
    ? value
        .flat(Infinity)
        .filter(Boolean)
        .map((item: any) => (typeof item === 'string' ? item : Array.isArray(item) ? flattenText(item) : ''))
        .join('\n')
    : typeof value === 'string'
      ? value
      : '';
const stripHtml = (value: string | null | undefined) =>
  value ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
const toSefariaUrlFromRef = (ref: string) => {
  const encoded = encodeURIComponent(normalizeRef(ref).replace(/\s+/g, '_'));
  return `https://www.sefaria.org/${encoded}?lang=bi`;
};

// Basic HTML text extraction helpers for web fetch
const stripScriptsAndStyles = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '');
const extractTitle = (html: string) => {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]) : 'Untitled';
};
const toText = (html: string) => stripHtml(stripScriptsAndStyles(html));

// HTML canonical URL and title helpers
function getMetaContent(doc: Document, selector: string): string | null {
  const el = doc.querySelector(selector) as HTMLMetaElement | null;
  return el?.getAttribute('content') || null;
}
function getCanonicalUrlFromDoc(doc: Document, baseUrl: string): string | undefined {
  const ogUrl = getMetaContent(doc, 'meta[property="og:url"]') || getMetaContent(doc, 'meta[name="og:url"]');
  let href = ogUrl || (doc.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || undefined;
  if (!href) return undefined;
  try { return new URL(href, baseUrl).toString(); } catch { return undefined; }
}
function getTitleFromDoc(doc: Document, fallbackHtml: string): string {
  const ogTitle = getMetaContent(doc, 'meta[property="og:title"]') || getMetaContent(doc, 'meta[name="og:title"]');
  if (ogTitle && ogTitle.trim()) return stripHtml(ogTitle);
  const t = doc.querySelector('title')?.textContent || extractTitle(fallbackHtml) || 'Untitled';
  return stripHtml(t);
}
function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[ \t\x0B\f\r]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// SSRF IP checks
function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  return (
    (parseInt(parts[0], 10) << 24) |
    (parseInt(parts[1], 10) << 16) |
    (parseInt(parts[2], 10) << 8) |
    (parseInt(parts[3], 10))
  ) >>> 0;
}
function inRange(n: number, start: string, maskBits: number): boolean {
  const s = ipToInt(start);
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (n & mask) === (s & mask);
}
function isPrivateOrReserved(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const n = ipToInt(ip);
    return (
      inRange(n, '10.0.0.0', 8) ||
      inRange(n, '172.16.0.0', 12) ||
      inRange(n, '192.168.0.0', 16) ||
      inRange(n, '127.0.0.0', 8) ||
      inRange(n, '169.254.0.0', 16) ||
      inRange(n, '0.0.0.0', 8)
    );
  }
  if (kind === 6) {
    const low = ip.toLowerCase();
    return low.startsWith('::1') || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd');
  }
  return true; // treat unknown as unsafe
}

const hasHebrew = (s: string) => /[\u0590-\u05FF]/.test(s);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Vision / OpenAI configuration
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL_VISION = (process.env.OPENAI_MODEL_VISION || 'gpt-4o-mini').trim();
const OPENAI_MODEL_TEXT = (process.env.OPENAI_MODEL_TEXT || 'gpt-4o-mini').trim();
const VISION_MAX_BYTES = Math.min(Math.max(parseInt(process.env.VISION_MAX_BYTES || '6000000', 10) || 6000000, 200000), 20000000);
const VISION_TIMEOUT_MS = Math.min(Math.max(parseInt(process.env.VISION_TIMEOUT_MS || '20000', 10) || 20000, 3000), 60000);

async function fetchJsonWithRetry(url: string | URL, init?: RequestInit, retries = 2, backoffMs = 400) {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 7000); // 7s timeout
      const u = typeof url === 'string' ? new URL(url) : url;
      const agent = u.protocol === 'http:' ? (httpAgent as any) : (httpsAgent as any);
      const options = { ...(init || {}), agent, signal: controller.signal } as RequestInit;
      const resp = await fetch(url, options);
      clearTimeout(t);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${txt?.slice(0,200)}`);
      }
      return await resp.json();
    } catch (err: any) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// Fetch an image buffer safely with size/type checks. Supports http(s) and data URIs.
async function loadImageAsDataUrl(image: string): Promise<{ dataUrl: string; mime: string; bytes: number; sha256: string }> {
  // data URI fast path
  if (image.startsWith('data:')) {
    const m = image.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('Unsupported data URI format');
    const mime = m[1];
    const b64 = m[2];
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > VISION_MAX_BYTES) throw new Error('Image exceeds size limit');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length, sha256 };
  }

  let u: URL;
  try { u = new URL(image); } catch { throw new Error('image must be a valid URL or data URI'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https/data URIs supported');

  // SSRF guard
  try {
    const { address } = await dns.lookup(u.hostname).catch(() => ({ address: '' }));
    if (u.hostname === 'localhost' || isPrivateOrReserved(address || '')) throw new Error('Blocked private/loopback host');
  } catch {}

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  const r = await fetch(u.toString(), { method: 'GET', signal: controller.signal } as RequestInit).finally(() => clearTimeout(t));
  if (!r.ok) throw new Error(`Image fetch failed: HTTP ${r.status}`);
  const ct = String(r.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/')) throw new Error('URL does not appear to be an image');
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > VISION_MAX_BYTES) throw new Error('Image exceeds size limit');
  const mime = ct.split(';')[0];
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { dataUrl, mime, bytes: buf.length, sha256 };
}

async function openAIVisionExtract(dataUrl: string, instructions: string): Promise<any> {
  if (!OPENAI_API_KEY) throw new Error('OpenAI not configured');
  // Use Chat Completions for broad compatibility
  const body: any = {
    model: OPENAI_MODEL_VISION,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You extract text and metadata from images. Output strict JSON with keys: text, languages (array of ISO codes like ["he","en"]).' },
      {
        role: 'user',
        content: [
          { type: 'text', text: instructions || 'Extract all Hebrew and English text, preserve line breaks.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.min(VISION_TIMEOUT_MS, 25000));
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body),
    signal: controller.signal
  } as RequestInit).finally(() => clearTimeout(t));
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${errTxt.slice(0,200)}`);
  }
  const j: any = await resp.json();
  const content = j?.choices?.[0]?.message?.content || '';
  try { return JSON.parse(content); } catch { return { text: String(content || ''), languages: [] }; }
}

async function openAITranslate(text: string, target: string): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OpenAI not configured');
  const body: any = {
    model: OPENAI_MODEL_TEXT,
    temperature: 0,
    messages: [
      { role: 'system', content: `Translate to ${target}. Keep proper nouns faithful. Return only the translation.` },
      { role: 'user', content: text }
    ]
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body), signal: controller.signal
  } as RequestInit).finally(() => clearTimeout(t));
  if (!resp.ok) throw new Error(`OpenAI translate error ${resp.status}`);
  const j: any = await resp.json();
  return String(j?.choices?.[0]?.message?.content || '').trim();
}

async function tryResolveExactRef(query: string): Promise<string | null> {
  try {
    const url = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(query)}`);
    url.searchParams.append('version', 'english');
    url.searchParams.append('version', 'hebrew');
    url.searchParams.append('return_format', 'text_only');
    const j: any = await fetchJsonWithRetry(url).catch(() => null);
    if (!j) return null;
    if (j && (j.ref || j.sectionRef)) return String(j.ref || j.sectionRef);
  } catch (_) {
    // ignore
  }
  return null;
}

async function fallbackSearchRefsFromText(text: string, size = 5) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return [] as any[];
  const snippet = trimmed.slice(0, 200);
  const body: any = {
    size,
    query: {
      match_phrase: {
        naive_lemmatizer: {
          query: snippet,
          slop: 10
        }
      }
    },
    highlight: {
      pre_tags: ['<b>'],
      post_tags: ['</b>'],
      fields: {
        naive_lemmatizer: {
          fragment_size: 200
        }
      }
    }
  };
  try {
    const data: any = await fetchJsonWithRetry('https://www.sefaria.org/api/search/text/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const hits: any[] = data?.hits?.hits || [];
    return hits
      .map((h: any) => {
        const src = h?._source || {};
        const ref = normalizeRef(String(src.ref || src.title || ''));
        if (!ref) return null;
        const highlight = (h.highlight?.naive_lemmatizer || h.highlight?.exact || [])[0];
        return {
          ref,
          url: toSefariaUrlFromRef(ref),
          text: highlight ? stripHtml(highlight) : undefined
        };
      })
      .filter(Boolean);
  } catch (_) {
    return [] as any[];
  }
}

// Search tool
server.registerTool(
  'search',
  {
    title: 'Sefaria Search',
    description: 'Search Sefaria texts',
    inputSchema: {
      query: z.string().min(1),
      size: z.number().int().min(1).max(25).optional(),
      lang: z.enum(['english', 'hebrew']).optional()
    },
    outputSchema: {
      results: z.array(
        z.object({ id: z.string(), title: z.string(), url: z.string().url() })
      )
    }
  },
  async ({ query, size = 10 }) => {
    const key = `search:${size}:${query}`;
    const cached = getCache<{ results: { id: string; title: string; url: string }[] }>(key);
    if (cached) {
      return {
        content: [{ type: 'text', text: JSON.stringify(cached) }],
        structuredContent: cached
      };
    }

    // Exact-ref fast path (English or Hebrew-like refs)
    if ((/:/.test(query) || /\d/.test(query) || hasHebrew(query)) && query.length <= 120) {
      const resolved = await tryResolveExactRef(query);
      if (resolved) {
        const result = { id: `${resolved}|auto|primary`, title: resolved, url: toSefariaUrlFromRef(resolved) };
        const output = { results: [result] };
        setCache(key, output);
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      }
    }

    let body: any = {
      size,
      highlight: {
        pre_tags: ['<b>'],
        post_tags: ['</b>'],
        fields: { naive_lemmatizer: { fragment_size: 200 } }
      },
      sort: [{ comp_date: {} }, { order: {} }],
      query: {
        match_phrase: { naive_lemmatizer: { query, slop: 10 } }
      }
    } as any;

    let data: any = await fetchJsonWithRetry('https://www.sefaria.org/api/search/text/_search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    let hits: any[] = data?.hits?.hits || [];

    // Hebrew fallback: if no hits and Hebrew present, try exact field
    if ((!hits || hits.length === 0) && hasHebrew(query)) {
      body = {
        size,
        highlight: { pre_tags: ['<b>'], post_tags: ['</b>'], fields: { exact: { fragment_size: 200 } } },
        query: { match_phrase: { exact: { query } } }
      };
      try {
        const data2: any = await fetchJsonWithRetry('https://www.sefaria.org/api/search/text/_search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        hits = data2?.hits?.hits || [];
      } catch {}
    }

    // Quick-win fallback: broaden to bool should (naive OR exact) for English queries
    if ((!hits || hits.length === 0) && !hasHebrew(query)) {
      const body2: any = {
        size,
        highlight: { pre_tags: ['<b>'], post_tags: ['</b>'], fields: { naive_lemmatizer: { fragment_size: 200 }, exact: { fragment_size: 200 } } },
        query: {
          bool: {
            should: [
              { match_phrase: { naive_lemmatizer: { query, slop: 8 } } },
              { match_phrase: { exact: { query } } }
            ]
          }
        }
      };
      try {
        const data3: any = await fetchJsonWithRetry('https://www.sefaria.org/api/search/text/_search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body2)
        });
        hits = data3?.hits?.hits || [];
      } catch {}
    }

    // Quick-win fallback: use find-refs extractor to propose refs when search is empty
    if (!hits || hits.length === 0) {
      try {
        const fr: any = await fetchJsonWithRetry('https://www.sefaria.org/api/find-refs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: query, return_text: 0 })
        });
        const arr: any[] = fr?.results || fr?.refs || fr?.matches || fr?.citations || [];
        const seen = new Set<string>();
        const fallbackResults = arr
          .map((m: any) => normalizeRef(String(m.ref || m.bestRef || m.heRef || '')))
          .filter(Boolean)
          .filter((r: string) => {
            if (seen.has(r)) return false;
            seen.add(r);
            return true;
          })
          .slice(0, size)
          .map((ref: string) => ({
            _source: { ref, title: ref },
            highlight: {}
          }));
        hits = fallbackResults;
      } catch {}
    }

    const results = (hits || []).map((h: any) => {
      const s = h?._source || {};
      const ref: string = normalizeRef(s.ref || s.title || '');
      const lang: string = s.lang || 'auto';
      const version: string = s.version || 'primary';
      const id = `${ref}|${lang}|${version}`;
      const url = toSefariaUrlFromRef(ref);
      const title: string = s.title || ref;
      return { id, title, url };
    });

    const output = { results };
    setCache(key, output);
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  }
);

// Fetch tool
server.registerTool(
  'fetch',
  {
    title: 'Fetch Sefaria Text',
    description: 'Fetch full text for a Sefaria ref (English + Hebrew)',
    inputSchema: { id: z.string().min(1), langPref: z.enum(['en','he','bi']).optional(), maxChars: z.number().int().min(200).max(200000).optional() },
    outputSchema: {
      id: z.string(),
      title: z.string(),
      text: z.string(),
      url: z.string().url(),
      metadata: z.record(z.any()).optional()
    }
  },
  async ({ id, langPref = 'en', maxChars }) => {
    if (id.startsWith('sheet:')) {
      const sheetId = id.split(':')[1];
      const url = `https://www.sefaria.org/api/sheets/${encodeURIComponent(sheetId)}`;
      const cached = getCache<any>(`sheet:${sheetId}`);
      const j = cached ?? (await fetchJsonWithRetry(url));
      if (!cached) setCache(`sheet:${sheetId}`, j, 10 * 60_000);
      const title: string = j.title || `Sheet ${sheetId}`;
      // Flatten sources text minimally
      const texts: string[] = [];
      function walkSources(sources: any[]) {
        for (const s of sources || []) {
          if (typeof s.outsideText === 'string') texts.push(s.outsideText);
          if (s.text && typeof s.text === 'string') texts.push(s.text);
          if (Array.isArray(s.sources)) walkSources(s.sources);
        }
      }
      walkSources(j.sources || []);
      const text = texts.join('\n\n');
      const pageUrl = `https://www.sefaria.org/sheets/${sheetId}`;
      const doc = { id, title, text, url: pageUrl, metadata: { owner: j.ownerName, status: j.status } };
      return { content: [{ type: 'text', text: JSON.stringify(doc) }], structuredContent: doc };
    }

    const [refRaw] = id.split('|');
    const ref = normalizeRef(refRaw);
    const cacheKey = `texts:${ref}`;
    const cached = getCache<any>(cacheKey);
    const u = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}`);
    u.searchParams.append('version', 'english');
    u.searchParams.append('version', 'hebrew');
    u.searchParams.append('return_format', 'text_only');
    const j = cached ?? (await fetchJsonWithRetry(u));
    if (!cached) setCache(cacheKey, j, 10 * 60_000);

    const title: string = j.indexTitle || j.title || ref;
    const pageUrl = toSefariaUrlFromRef(ref);
    const findLang = (arr: any[], targets: string[]) =>
      arr?.find((v: any) => targets.includes(String(v.actualLanguage || v.language || '').toLowerCase()));
    const enEntry = findLang(j.versions || [], ['en', 'english']);
    const heEntry = findLang(j.versions || [], ['he', 'hebrew']);
    const english = enEntry?.text;
    const hebrew = heEntry?.text;
    const enText = flattenText(english);
    const heText = flattenText(hebrew);
    let text = enText || heText || '';
    if (langPref === 'he') text = heText || enText || '';
    if (langPref === 'bi') text = [enText, heText].filter(Boolean).join('\n\n— — —\n\n');
    const metadata: Record<string, any> = {
      heRef: j.heRef,
      hebrew_text: heText,
      english_text: enText,
      categories: j.categories,
      available_versions: j.available_versions
    };
    if (typeof maxChars === 'number' && text.length > maxChars) {
      text = text.slice(0, maxChars);
      metadata.truncated = true;
    }
    const doc = { id, title, text, url: pageUrl, metadata };
    return { content: [{ type: 'text', text: JSON.stringify(doc) }], structuredContent: doc };
  }
);

// Commentaries for a ref
server.registerTool(
  'get_commentaries',
  {
    title: 'Commentaries',
    description: 'List commentaries related to a reference',
    inputSchema: { ref: z.string().min(1) },
    outputSchema: { items: z.array(z.object({ ref: z.string(), title: z.string(), url: z.string().url() })) }
  },
  async ({ ref }) => {
    const url = new URL(`https://www.sefaria.org/api/related/${encodeURIComponent(ref)}`);
    const j: any = await fetchJsonWithRetry(url);
    const links: any[] = j?.links || [];
    const items = links
      .map((ln: any) => {
        const r = normalizeRef(String(ln.ref || ln.anchorRef || ''));
        if (!r) return null;
        const title = String(ln.sourceRef || ln.category || r);
        return { ref: r, title, url: toSefariaUrlFromRef(r) };
      })
      .filter(Boolean);
    const out = { items };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

// Compare versions for a ref (multi-version fetch)
server.registerTool(
  'compare_versions',
  {
    title: 'Compare Versions',
    description: 'Fetch multiple versions for a ref to compare texts',
    inputSchema: {
      ref: z.string().min(1),
      versions: z.array(z.string()).optional(), // e.g., ["english|The Contemporary Torah, JPS, 2006", "hebrew|Miqra according to the Masorah"]
      languages: z.array(z.enum(['en','he','english','hebrew'])).optional(),
      maxChars: z.number().int().min(200).max(300000).optional()
    },
    outputSchema: {
      ref: z.string(),
      items: z.array(
        z.object({ language: z.string().optional(), versionTitle: z.string().optional(), text: z.string() })
      ),
      metadata: z.record(z.any()).optional()
    }
  },
  async ({ ref, versions, languages, maxChars }) => {
    const u = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}`);
    const langs = (languages || []).map(x => (x === 'en' ? 'english' : x === 'he' ? 'hebrew' : x.toLowerCase()));
    const addVersionParam = (v: string) => u.searchParams.append('version', v);
    if (versions && versions.length > 0) {
      for (const v of versions) addVersionParam(v);
    } else if (langs.length > 0) {
      for (const lang of langs) addVersionParam(lang);
    } else {
      addVersionParam('english');
      addVersionParam('hebrew');
    }
    u.searchParams.append('return_format', 'text_only');
    const j: any = await fetchJsonWithRetry(u);
    const items = (j?.versions || []).map((v: any) => ({
      language: String(v.actualLanguage || v.language || ''),
      versionTitle: String(v.versionTitle || v.shortVersionTitle || ''),
      text: flattenText(v.text)
    }));
    // Truncation if requested
    const meta: Record<string, any> = { heRef: j.heRef, title: j.title || j.indexTitle || ref };
    if (typeof maxChars === 'number') {
      for (const it of items) {
        if (it.text && it.text.length > maxChars) {
          it.text = it.text.slice(0, maxChars);
          meta.truncated = true;
        }
      }
    }
    const out = { ref, items, metadata: meta };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

// Daily/weekly learning schedule (Calendars API)
server.registerTool(
  'get_daily_learnings',
  {
    title: 'Daily Learnings',
    description: 'Retrieve Sefaria calendar schedules (parsha, daf yomi, etc.)',
    inputSchema: {
      diaspora: z.boolean().optional(),
      custom: z.string().optional(),
      year: z.number().int().optional(),
      month: z.number().int().optional(),
      day: z.number().int().optional(),
      timezone: z.string().optional()
    },
    outputSchema: { schedule: z.any() }
  },
  async ({ diaspora = true, custom, year, month, day, timezone }) => {
    const url = new URL('https://www.sefaria.org/api/calendars');
    if (typeof diaspora === 'boolean') url.searchParams.set('diaspora', diaspora ? '1' : '0');
    if (custom) url.searchParams.set('custom', custom);
    if (year && month && day) {
      url.searchParams.set('year', String(year));
      url.searchParams.set('month', String(month));
      url.searchParams.set('day', String(day));
    }
    if (timezone) url.searchParams.set('timezone', timezone);
    const j = await fetchJsonWithRetry(url);
    const out = { schedule: j };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

// Find refs within free text (Linker API)
server.registerTool(
  'find_refs',
  {
    title: 'Find Refs',
    description: 'Extract Sefaria references from free text',
    inputSchema: { text: z.string().min(1), lang: z.enum(['en', 'he']).optional(), return_text: z.boolean().optional() },
    outputSchema: {
      matches: z.array(
        z.object({ ref: z.string(), url: z.string().url(), heRef: z.string().optional(), text: z.string().optional(), start: z.number().optional(), end: z.number().optional() })
      ),
      metadata: z.record(z.any()).optional()
    }
  },
  async ({ text, lang, return_text = false }) => {
    const body: any = { text };
    if (typeof return_text === 'boolean') body.return_text = return_text ? 1 : 0;
    if (lang) body.lang = lang;
    let response: any;
    let fetchError: any;
    try {
      response = await fetchJsonWithRetry('https://www.sefaria.org/api/find-refs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      fetchError = err;
    }
    const arr: any[] = (response?.results || response?.refs || response?.matches || response?.citations || []);
    let matches = arr
      .map((m: any) => {
        const ref = normalizeRef(String(m.ref || m.bestRef || m.heRef || ''));
        if (!ref) return null;
        return {
          ref,
          url: toSefariaUrlFromRef(ref),
          heRef: m.heRef || undefined,
          text: m.text || m.citation || undefined,
          start: typeof m.start === 'number' ? m.start : undefined,
          end: typeof m.end === 'number' ? m.end : undefined
        };
      })
      .filter(Boolean);
    const metadata: Record<string, any> = {};
    if (fetchError) {
      metadata.findRefsError = String(fetchError?.message || fetchError);
    }
    if (matches.length === 0) {
      const fallback = await fallbackSearchRefsFromText(text, 5);
      if (fallback.length > 0) {
        matches = fallback;
        metadata.fallbackUsed = 'search';
      }
    }
    if (!metadata.fallbackUsed && !metadata.findRefsError) {
      // no metadata worth reporting
      const out = { matches };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    }
    const out = { matches, metadata };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

// --- Vision tools ---
server.registerTool(
  'vision_extract_text',
  {
    title: 'Vision: Extract Text',
    description: 'Extract Hebrew and English text from an image (URL or data URI).',
    inputSchema: { image: z.string().min(1) },
    outputSchema: { extracted_text: z.string(), languages: z.array(z.string()).optional(), bytes: z.number().optional(), mime: z.string().optional(), image_hash: z.string().optional() }
  },
  async ({ image }) => {
    const loaded = await loadImageAsDataUrl(image);
    const res = await openAIVisionExtract(loaded.dataUrl, 'Extract all visible Hebrew and English text. Output JSON: {"text": string, "languages": [..]}.');
    const text = normalizeText(String(res?.text || ''));
    const out = { extracted_text: text, languages: Array.isArray(res?.languages) ? res.languages : undefined, bytes: loaded.bytes, mime: loaded.mime, image_hash: loaded.sha256 };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

server.registerTool(
  'vision_identify_source',
  {
    title: 'Vision: Identify Source',
    description: 'Identify Sefaria references from extracted text snippets.',
    inputSchema: { text: z.string().min(1), size: z.number().int().min(1).max(10).optional() },
    outputSchema: { candidates: z.array(z.object({ ref: z.string(), url: z.string().url(), text: z.string().optional() })) }
  },
  async ({ text, size = 5 }) => {
    const matches = await fallbackSearchRefsFromText(text, size);
    const candidates = (matches || []).slice(0, size).map((m: any) => ({ ref: m.ref, url: m.url, text: m.text }));
    const out = { candidates };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

server.registerTool(
  'vision_extract_and_find_refs',
  {
    title: 'Vision: Extract + Find Refs',
    description: 'Extract text from image and find matching Sefaria references with optional excerpts.',
    inputSchema: { image: z.string().min(1), maxRefs: z.number().int().min(1).max(6).optional(), langPref: z.enum(['en','he','bi']).optional() },
    outputSchema: {
      extracted_text: z.string(),
      candidates: z.array(z.object({ ref: z.string(), url: z.string().url(), text: z.string().optional() })),
      sources: z.array(z.object({ id: z.string(), title: z.string(), text: z.string(), url: z.string().url() })).optional()
    }
  },
  async ({ image, maxRefs = 3, langPref = 'en' }) => {
    const loaded = await loadImageAsDataUrl(image);
    const res = await openAIVisionExtract(loaded.dataUrl, 'Extract all visible Hebrew and English text. Output JSON: {"text": string, "languages": [..]}.');
    const extracted = normalizeText(String(res?.text || ''));
    const matches = await fallbackSearchRefsFromText(extracted, Math.max(maxRefs, 3));
    const candidates = (matches || []).slice(0, maxRefs).map((m: any) => ({ ref: m.ref, url: m.url, text: m.text }));
    // Fetch small excerpts for the top refs using existing fetch tool logic
    const sources: Array<{ id: string; title: string; text: string; url: string }> = [];
    for (const c of candidates) {
      try {
        const u = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(c.ref)}`);
        u.searchParams.append('version', 'english');
        u.searchParams.append('version', 'hebrew');
        u.searchParams.append('return_format', 'text_only');
        const j: any = await fetchJsonWithRetry(u);
        const title: string = j.indexTitle || j.title || c.ref;
        const findLang = (arr: any[], targets: string[]) => arr?.find((v: any) => targets.includes(String(v.actualLanguage || v.language || '').toLowerCase()));
        const enText = flattenText(findLang(j?.versions || [], ['en','english'])?.text || '');
        const heText = flattenText(findLang(j?.versions || [], ['he','hebrew'])?.text || '');
        let text = enText || heText || '';
        if (langPref === 'he') text = heText || enText || '';
        if (langPref === 'bi') text = [enText, heText].filter(Boolean).join('\n\n— — —\n\n');
        sources.push({ id: c.ref, title, text: text.slice(0, 1200), url: c.url });
      } catch {}
    }
    const out = { extracted_text: extracted, candidates, sources: sources.length ? sources : undefined };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

server.registerTool(
  'vision_translate',
  {
    title: 'Vision: Translate Text',
    description: 'Translate Hebrew text to target language (prefers Sefaria translations if ref can be identified).',
    inputSchema: { text: z.string().min(1), target_lang: z.enum(['en','he','fr','es']).optional() },
    outputSchema: { translation: z.string(), sourceRef: z.string().optional(), url: z.string().url().optional(), method: z.enum(['sefaria','model']).optional() }
  },
  async ({ text, target_lang = 'en' }) => {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
    let ref: string | null = null;
    try { ref = await tryResolveExactRef(snippet); } catch {}
    if (ref) {
      try {
        const u = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}`);
        u.searchParams.append('version', target_lang === 'he' ? 'hebrew' : 'english');
        u.searchParams.append('return_format', 'text_only');
        const j: any = await fetchJsonWithRetry(u);
        const findLang = (arr: any[], targets: string[]) => arr?.find((v: any) => targets.includes(String(v.actualLanguage || v.language || '').toLowerCase()));
        const v = findLang(j?.versions || [], target_lang === 'he' ? ['he','hebrew'] : ['en','english']);
        const outText = normalizeText(flattenText(v?.text || ''));
        if (outText) {
          const out = { translation: outText, sourceRef: ref, url: toSefariaUrlFromRef(ref), method: 'sefaria' as const };
          return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
        }
      } catch {}
    }
    const translated = await openAITranslate(text, target_lang === 'he' ? 'Hebrew' : 'English');
    const out = { translation: translated, method: 'model' as const };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

// Sugya explorer tool
server.registerTool(
  'sugya_explorer',
  {
    title: 'Sugya Explorer',
    description: 'Gather core text, cross-references, sheets, and topics for a sugya/ref',
    inputSchema: {
      ref: z.string().min(1),
      includeText: z.boolean().optional(),
      maxTextChars: z.number().int().min(200).max(8000).optional(),
      maxPerCategory: z.number().int().min(1).max(15).optional(),
      maxSheets: z.number().int().min(1).max(20).optional(),
      maxTopics: z.number().int().min(1).max(20).optional()
    },
    outputSchema: {
      ref: z.string(),
      heRef: z.string().optional(),
      url: z.string().url(),
      title: z.string().optional(),
      categories: z.array(
        z.object({
          category: z.string(),
          items: z.array(
            z.object({
              ref: z.string(),
              title: z.string(),
              url: z.string().url(),
              heRef: z.string().optional(),
              type: z.string().optional(),
              score: z.number().optional()
            })
          )
        })
      ),
      sheets: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string().url(),
          owner: z.string().optional(),
          summary: z.string().optional(),
          views: z.number().optional(),
          topics: z.array(z.object({ slug: z.string(), titleEn: z.string().optional(), titleHe: z.string().optional() })).optional()
        })
      ).optional(),
      topics: z.array(z.object({ slug: z.string(), titleEn: z.string().optional(), titleHe: z.string().optional(), description: z.string().optional() })).optional(),
      text: z.string().optional(),
      metadata: z.record(z.any()).optional()
    }
  },
  async ({ ref, includeText = true, maxTextChars, maxPerCategory = 5, maxSheets = 6, maxTopics = 6 }) => {
    const normRef = normalizeRef(ref);
    // Quick-win: resolve vague topics to canonical refs where possible
    let seedRef = normRef;
    if ((/:/.test(normRef) || /\d/.test(normRef) || hasHebrew(normRef)) && normRef.length <= 120) {
      try {
        const exact = await tryResolveExactRef(normRef);
        if (exact) seedRef = exact;
      } catch {}
    }
    if (seedRef === normRef) {
      const lower = normRef.toLowerCase();
      for (const a of SUGYA_ALIASES) {
        if (a.pattern.test(lower)) { seedRef = a.ref; break; }
      }
    }
    const cacheKey = `sugya:${normRef}:${includeText}:${maxTextChars || ''}:${maxPerCategory}:${maxSheets}:${maxTopics}`;
    const cached = getCache<any>(cacheKey);
    if (cached) {
      return { content: [{ type: 'text', text: JSON.stringify(cached) }], structuredContent: cached };
    }

    const relatedUrl = new URL(`https://www.sefaria.org/api/related/${encodeURIComponent(seedRef)}`);
    // Avoid heavy 'related' calls for broad Shulchan Arukh refs; rely on search fallback instead
    const avoidRelated = /Shulchan\s+Arukh/i.test(seedRef);
    const related: any = avoidRelated ? {} : await fetchJsonWithRetry(relatedUrl);

    let textBlock: string | undefined;
    let english: string | undefined;
    let hebrew: string | undefined;
    let heRef: string | undefined;
    let title: string | undefined;
    const textMeta: Record<string, any> = {};

    if (includeText) {
      const textUrl = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(seedRef)}`);
      textUrl.searchParams.append('version', 'english');
      textUrl.searchParams.append('version', 'hebrew');
      textUrl.searchParams.append('return_format', 'text_only');
      const textJson: any = await fetchJsonWithRetry(textUrl);
      const findLang = (arr: any[], targets: string[]) =>
        arr?.find((v: any) => targets.includes(String(v.actualLanguage || v.language || '').toLowerCase()));
      const enEntry = findLang(textJson?.versions || [], ['en', 'english']);
      const heEntry = findLang(textJson?.versions || [], ['he', 'hebrew']);
      english = flattenText(enEntry?.text);
      hebrew = flattenText(heEntry?.text);
      title = textJson?.indexTitle || textJson?.title || seedRef;
      heRef = textJson?.heRef || undefined;
      if (english || hebrew) {
        textBlock = includeText === true ? [english, hebrew].filter(Boolean).join('\n\n— — —\n\n') : undefined;
        if (typeof maxTextChars === 'number' && textBlock) {
          if (textBlock.length > maxTextChars) {
            textBlock = textBlock.slice(0, maxTextChars);
            textMeta.truncated = true;
          }
        }
      }
      if (textJson?.categories) textMeta.categories = textJson.categories;
      if (textJson?.available_versions) textMeta.available_versions = textJson.available_versions;
    }

    const linkLimit = /Shulchan\s+Arukh/i.test(seedRef) ? 300 : 800;
    const links: any[] = (related?.links || []).slice(0, linkLimit);
    const grouped = new Map<string, any[]>();
    for (const ln of links) {
      const targetRef = normalizeRef(String(ln.ref || ln.sourceRef || ''));
      if (!targetRef) continue;
      const category = String(ln.category || ln.collectiveTitle?.en || 'Other');
      const order = ln.order || {};
      const score = Number(order.pr || 0) * 3 + Number(order.tfidf || 0) * 2 + Number(order.views || 0) / 1000 + Number(order.numDatasource || 0);
      const record = {
        ref: targetRef,
        title: String(ln.collectiveTitle?.en || ln.index_title || ln.ref || ln.sourceRef || targetRef),
        url: toSefariaUrlFromRef(targetRef),
        heRef: ln.sourceHeRef || undefined,
        type: ln.type || undefined,
        score
      };
      const arr = grouped.get(category) ?? [];
      arr.push(record);
      grouped.set(category, arr);
    }

    let categoryPayload = Array.from(grouped.entries()).map(([category, arr]) => ({
      category,
      items: arr
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, maxPerCategory)
    }));

    // Quick-win fallback: if no related categories found, seed with search-based matches
    if (!categoryPayload.length) {
      try {
        const fallback = await fallbackSearchRefsFromText(normRef, Math.min(maxPerCategory, 8));
        if (fallback && fallback.length) {
          categoryPayload = [
            {
              category: 'Search Matches',
              items: fallback.slice(0, maxPerCategory).map((it: any) => ({
                ref: it.ref,
                title: it.ref,
                url: it.url,
                type: 'search',
                score: 0
              }))
            }
          ];
        }
      } catch {}
    }

    const sheetsRaw: any[] = (related?.sheets || []).slice(0, 50);
    const sheetsList: any[] = [];
    const seenSheetIds = new Set<string>();
    for (const sheet of sheetsRaw) {
      if (sheetsList.length >= maxSheets) break;
      const id = String(sheet.id || sheet._id || '').trim();
      const sheetId = id || String(sheet.sheetUrl || '').split('/').pop() || '';
      if (!sheetId || seenSheetIds.has(sheetId)) continue;
      const url = sheet.sheetUrl ? `https://www.sefaria.org${sheet.sheetUrl}` : `https://www.sefaria.org/sheets/${sheetId}`;
      const entry = {
        id: sheetId,
        title: stripHtml(sheet.title) || `Sheet ${sheetId}`,
        url,
        owner: sheet.ownerName || undefined,
        summary: sheet.summary ? stripHtml(sheet.summary) : undefined,
        views: typeof sheet.views === 'number' ? sheet.views : undefined,
        topics: Array.isArray(sheet.topics)
          ? sheet.topics
              .map((tp: any) => ({ slug: String(tp.slug || tp.asTyped || '').trim(), titleEn: tp.en, titleHe: tp.he }))
              .filter((tp: any) => tp.slug)
          : undefined
      };
      sheetsList.push(entry);
      seenSheetIds.add(sheetId);
    }

    const sheets = sheetsList;

    const topicsRaw: any[] = (related?.topics || []).slice(0, 50);
    const topicList: any[] = [];
    const seenTopicSlugs = new Set<string>();
    for (const tp of topicsRaw) {
      if (topicList.length >= maxTopics) break;
      const slug = String(tp.topic || tp.slug || '').trim();
      if (!slug || seenTopicSlugs.has(slug)) continue;
      topicList.push({
        slug,
        titleEn: tp.title?.en,
        titleHe: tp.title?.he,
        description: tp.description?.en || tp.descriptions?.en?.title || undefined
      });
      seenTopicSlugs.add(slug);
    }
    const topics = topicList;

    const payload = {
      ref: seedRef,
      heRef,
      url: toSefariaUrlFromRef(seedRef),
      title,
      categories: categoryPayload,
      sheets: sheets.length ? sheets : undefined,
      topics: topics.length ? topics : undefined,
      text: textBlock,
      metadata: {
        totalLinkCount: links.length,
        sheetCount: sheetsRaw.length,
        topicCount: topicsRaw.length,
        englishSnippet: english ? english.slice(0, 400) : undefined,
        hebrewSnippet: hebrew ? hebrew.slice(0, 400) : undefined,
        ...textMeta
      }
    };

    setCache(cacheKey, payload, 3 * 60_000);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
);

// Topics search tool (search Sefaria for relevant refs)
server.registerTool(
  'topics_search',
  {
    title: 'Topics Search',
    description: 'Search Sefaria for sources related to a topic',
    inputSchema: { topic: z.string().min(1) },
    outputSchema: {
      results: z.array(
        z.object({
          ref: z.string(),
          title: z.string(),
          url: z.string().url(),
          snippet: z.string().optional()
        })
      )
    }
  },
  async ({ topic }) => {
    const query = topic.trim();
    const body = {
      size: 8,
      highlight: {
        pre_tags: [''],
        post_tags: [''],
        fields: { naive_lemmatizer: { fragment_size: 180 } }
      },
      query: {
        bool: {
          should: [
            { match_phrase: { naive_lemmatizer: { query, slop: 8 } } },
            { match_phrase: { exact: { query } } }
          ]
        }
      }
    };

    const data: any = await fetchJsonWithRetry('https://www.sefaria.org/api/search/text/_search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const hits: any[] = data?.hits?.hits || [];
    const results = hits.slice(0, 8).map((h: any) => {
      const s = h?._source || {};
      const ref = normalizeRef(s.ref || s.title || '');
      const snippet = (h.highlight?.naive_lemmatizer || h.highlight?.exact || [])[0];
      return {
        ref,
        title: s.title || ref,
        url: toSefariaUrlFromRef(ref),
        snippet: snippet ? snippet.replace(/\s+/g, ' ').trim() : undefined
      };
    });

    const out = { results };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

// Parsha pack tool (user-focused parsha briefing)
server.registerTool(
  'parsha_pack',
  {
    title: 'Parsha Pack',
    description: 'Generate a user-ready parsha and haftarah packet for a given date',
    inputSchema: {
      date: z.string().regex(/\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD format').optional(),
      diaspora: z.boolean().optional(),
      custom: z.enum(['ashkenazi', 'sephardi', 'edot%20hamizrach']).optional(),
      timezone: z.string().optional(),
      includeAliyot: z.boolean().optional(),
      includeLearningTracks: z.boolean().optional(),
      limitLearningTracks: z.number().int().min(1).max(12).optional()
    },
    outputSchema: {
      date: z.string(),
      timezone: z.string().optional(),
      parsha: z.object({
        nameEn: z.string(),
        nameHe: z.string().optional(),
        ref: z.string(),
        heRef: z.string().optional(),
        url: z.string().url(),
        summaryEn: z.string().optional(),
        summaryHe: z.string().optional(),
        aliyot: z.array(z.string()).optional()
      }),
      haftarot: z.array(z.object({ title: z.string(), ref: z.string(), url: z.string().url() })).optional(),
      highlights: z.array(z.object({ title: z.string(), display: z.string(), url: z.string().optional(), category: z.string().optional() })).optional(),
      learningTracks: z.array(z.object({ title: z.string(), ref: z.string(), url: z.string().url(), display: z.string().optional() })).optional()
    }
  },
  async ({ date, diaspora = true, custom, timezone, includeAliyot = true, includeLearningTracks = true, limitLearningTracks = 6 }) => {
    const url = new URL('https://www.sefaria.org/api/calendars');
    if (typeof diaspora === 'boolean') url.searchParams.set('diaspora', diaspora ? '1' : '0');
    if (custom) url.searchParams.set('custom', custom);
    if (timezone) url.searchParams.set('timezone', timezone);
    if (date) {
      const [year, month, day] = date.split('-').map(Number);
      if (year && month && day) {
        url.searchParams.set('year', String(year));
        url.searchParams.set('month', String(month));
        url.searchParams.set('day', String(day));
      }
    }

    const data: any = await fetchJsonWithRetry(url);
    const calendarItems: any[] = data?.calendar_items || [];
    const parshaItem = calendarItems.find((item: any) => item?.title?.en === 'Parashat Hashavua');
    if (!parshaItem) {
      throw new Error('No parsha data returned for the requested date');
    }

    const parsha = {
      nameEn: parshaItem.displayValue?.en || parshaItem.displayValue || parshaItem.ref,
      nameHe: parshaItem.displayValue?.he,
      ref: parshaItem.ref,
      heRef: parshaItem.heRef,
      url: toSefariaUrlFromRef(parshaItem.ref),
      summaryEn: parshaItem.description?.en,
      summaryHe: parshaItem.description?.he,
      aliyot: includeAliyot ? parshaItem.extraDetails?.aliyot || undefined : undefined
    };

    const haftarot = calendarItems
      .filter((item: any) => String(item?.title?.en || '').startsWith('Haftarah'))
      .map((item: any) => ({
        title: item.title?.en || item.title || 'Haftarah',
        ref: item.ref || item.url,
        url: item.url ? toSefariaUrlFromRef(item.url.replace(/_/g, ' ')) : toSefariaUrlFromRef(item.ref || '')
      }));

    const highlightTitles = new Set(['Parashat Hashavua', 'Haftarah']);
    const highlights = calendarItems
      .filter((item: any) => !highlightTitles.has(item?.title?.en || item?.title) && item.displayValue)
      .slice(0, 8)
      .map((item: any) => ({
        title: item.title?.en || item.title || '',
        display: item.displayValue?.en || item.displayValue || '',
        category: item.category,
        url: item.url ? toSefariaUrlFromRef(item.url) : undefined
      }))
      .filter((item: any) => item.title && item.display);

    let learningTracks;
    if (includeLearningTracks) {
      const preferred = new Set([
        'Daf Yomi',
        'Yerushalmi Yomi',
        'Daily Mishnah',
        'Daily Rambam',
        'Daily Rambam (3 Chapters)',
        'Tanakh Yomi',
        'Tanya Yomi',
        'Halakhah Yomit',
        'Arukh HaShulchan Yomi',
        'Chok LeYisrael'
      ]);
      learningTracks = calendarItems
        .filter((item: any) => preferred.has(item?.title?.en || item?.title))
        .slice(0, limitLearningTracks)
        .map((item: any) => ({
          title: item.title?.en || item.title || '',
          ref: item.ref || item.url,
          url: item.url ? toSefariaUrlFromRef(item.url) : toSefariaUrlFromRef(item.ref || ''),
          display: item.displayValue?.en || item.displayValue || undefined
        }))
        .filter((entry: any) => entry.title && entry.url);
    }

    const payload = {
      date: data?.date || (date ?? new Date().toISOString().slice(0, 10)),
      timezone: data?.timezone || timezone,
      parsha,
      haftarot: haftarot.length ? haftarot : undefined,
      highlights: highlights.length ? highlights : undefined,
      learningTracks: learningTracks && learningTracks.length ? learningTracks : undefined
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
);

server.registerTool(
  'topic_sheet_curator',
  {
    title: 'Topic Sheet Curator',
    description: 'Find top Sefaria source sheets for a given topic',
    inputSchema: {
      topic: z.string().min(1),
      maxSheets: z.number().int().min(1).max(15).optional()
    },
    outputSchema: {
      topic: z.string(),
      slug: z.string().optional(),
      sheets: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string().url(),
          summary: z.string().optional(),
          owner: z.string().optional(),
          views: z.number().optional(),
          createdAt: z.string().optional(),
          tags: z.array(z.string()).optional()
        })
      ),
      metadata: z.record(z.any()).optional()
    }
  },
  async ({ topic, maxSheets = 8 }) => {
    const trimmed = topic.trim();
    if (!trimmed) {
      throw new Error('Topic cannot be empty');
    }

    const cleaned = trimmed.toLowerCase().replace(/[^\p{L}\p{N}\s\-]+/gu, '').trim();
    const slugCandidates = Array.from(
      new Set(
        [
          trimmed,
          cleaned,
          cleaned.replace(/\s+/g, '-'),
          cleaned.replace(/\s+/g, '_'),
          trimmed.replace(/\s+/g, '-')
        ].filter(Boolean)
      )
    );

    let topicData: any = null;
    let resolvedSlug: string | undefined;
    for (const candidate of slugCandidates) {
      const url = new URL(`https://www.sefaria.org/api/v2/topics/${encodeURIComponent(candidate)}`);
      url.searchParams.set('with_refs', '1');
      const resp: any = await fetchJsonWithRetry(url).catch(() => ({}));
      if (resp && resp.slug) {
        topicData = resp;
        resolvedSlug = candidate;
        break;
      }
    }

    const collected: any[] = [];
    const seen = new Set<string>();
    const addSheetById = async (id: string) => {
      if (!id || seen.has(id) || collected.length >= maxSheets) return;
      const sheetData: any = await fetchJsonWithRetry(`https://www.sefaria.org/api/sheets/${encodeURIComponent(id)}`);
      const sheet = {
        id,
        title: stripHtml(sheetData?.title) || `Sheet ${id}`,
        url: `https://www.sefaria.org/sheets/${id}`,
        summary: sheetData?.summary ? stripHtml(sheetData.summary) : undefined,
        owner: sheetData?.ownerName || undefined,
        views: typeof sheetData?.views === 'number' ? sheetData.views : undefined,
        createdAt: sheetData?.dateCreated || undefined,
        tags: Array.isArray(sheetData?.topics) ? sheetData.topics.map((tp: any) => tp.slug || tp.asTyped || '').filter(Boolean) : undefined
      };
      collected.push(sheet);
      seen.add(id);
    };

    if (topicData?.refs) {
      const groups = Object.values(topicData.refs) as any[];
      for (const group of groups) {
        const refs = Array.isArray(group?.refs) ? group.refs : [];
        for (const entry of refs) {
          if (collected.length >= maxSheets) break;
          if (entry?.is_sheet) {
            const id = String(entry.ref || '').replace(/Sheet\s*/i, '').trim();
            if (id) await addSheetById(id);
          }
        }
      }
    }

    let fallbackUsed = false;
    if (collected.length < Math.max(3, maxSheets / 2)) {
      fallbackUsed = true;
      const body = {
        size: 5,
        query: { match_phrase: { naive_lemmatizer: { query: trimmed, slop: 6 } } }
      };
      const search: any = await fetchJsonWithRetry('https://www.sefaria.org/api/search/text/_search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const hits: any[] = search?.hits?.hits || [];
      for (const hit of hits) {
        if (collected.length >= maxSheets) break;
        const refName = normalizeRef(hit?._source?.ref || hit?._source?.title || '');
        if (!refName) continue;
        const rel: any = await fetchJsonWithRetry(`https://www.sefaria.org/api/related/${encodeURIComponent(refName)}`);
        const sheets: any[] = rel?.sheets || [];
        for (const sheet of sheets.slice(0, 3)) {
          if (collected.length >= maxSheets) break;
          const id = String(sheet.id || sheet._id || '').trim() || String(sheet.sheetUrl || '').split('/').pop() || '';
          if (id) await addSheetById(id);
        }
      }
    }

    if (!collected.length) {
      throw new Error('No source sheets found for that topic');
    }

    const payload = {
      topic: topicData?.primaryTitle?.en || trimmed,
      slug: resolvedSlug,
      sheets: collected.slice(0, maxSheets),
      metadata: {
        totalCollected: collected.length,
        fallbackUsed
      }
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
);

// Insight Layers: compare key commentaries with bilingual quotes
server.registerTool(
  'insight_layers',
  {
    title: 'Insight Layers',
    description: 'Compare commentaries (Rashi, Ramban, Ibn Ezra, Sforno, etc.) on a ref with bilingual quotes',
    inputSchema: {
      ref: z.string().min(1),
      commentators: z.array(z.string()).nullable().optional(),
      maxChars: z.number().int().min(200).max(3000).optional()
    },
    outputSchema: {
      ref: z.string(),
      url: z.string().url(),
      items: z.array(
        z.object({
          name: z.string(),
          available: z.boolean(),
          ref: z.string().optional(),
          url: z.string().url().optional(),
          quoteEn: z.string().optional(),
          quoteHe: z.string().optional(),
          summaryEn: z.string().optional(),
          themes: z.array(z.string()).optional()
        })
      ),
      metadata: z.record(z.any()).optional()
    }
  },
  async ({ ref, commentators = null, maxChars = 600 }) => {
    const normRef = normalizeRef(ref);
    const cacheKey = `insight:${normRef}:${(commentators||[]).join(',')}:${maxChars}`;
    const cached = getCache<any>(cacheKey);
    if (cached) return { content: [{ type: 'text', text: JSON.stringify(cached) }], structuredContent: cached };

    const relatedUrl = new URL(`https://www.sefaria.org/api/related/${encodeURIComponent(normRef)}`);
    const related: any = await fetchJsonWithRetry(relatedUrl).catch(() => ({}));
    const links: any[] = Array.isArray(related?.links) ? related.links : [];
    const isCommentary = (ln: any) => String(ln?.type || '').toLowerCase() === 'commentary' || String(ln?.category || '').toLowerCase() === 'commentary';
    const commentaryLinks = links.filter(isCommentary);

    const scoreOf = (ln: any) => {
      const order = ln?.order || {};
      return Number(order.pr || 0) * 3 + Number(order.tfidf || 0) * 2 + Number(order.views || 0) / 1000 + Number(order.numDatasource || 0);
    };

    const titleOf = (ln: any) => String(ln?.collectiveTitle?.en || ln?.index_title || ln?.sourceRef || ln?.ref || '').trim();
    const refOf = (ln: any) => normalizeRef(String(ln?.ref || ln?.sourceRef || ''));

    const defaultNames = ['Rashi', 'Ibn Ezra', 'Ramban', 'Sforno'];
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    const requested = (Array.isArray(commentators) ? commentators : defaultNames).map((n: any) => String(n)).filter(Boolean);
    const requestedSet = new Set(requested.map(norm));

    // Add top 2 additional commentators from related if not explicitly requested
    if (!commentators) {
      const byName = new Map<string, { name: string; score: number }>();
      for (const ln of commentaryLinks) {
        const nm = titleOf(ln);
        if (!nm) continue;
        const key = norm(nm);
        if (requestedSet.has(key)) continue;
        const s = scoreOf(ln);
        const prev = byName.get(key);
        if (!prev || s > prev.score) byName.set(key, { name: nm, score: s });
      }
      const extra = Array.from(byName.values()).sort((a, b) => b.score - a.score).slice(0, 2).map(x => x.name);
      for (const x of extra) if (!requestedSet.has(norm(x))) requested.push(x);
    }

    // group links by commentator name and pick best per name
    const bestByName = new Map<string, any>();
    for (const ln of commentaryLinks) {
      const nm = titleOf(ln);
      if (!nm) continue;
      const key = norm(nm);
      if (!requestedSet.has(key) && !requested.some(r => norm(r) === key)) continue;
      const prev = bestByName.get(key);
      if (!prev || scoreOf(ln) > scoreOf(prev)) bestByName.set(key, ln);
    }

    const stopwords = new Set<string>([
      'the','and','or','of','to','in','a','an','on','for','with','by','that','this','from','as','at','it','is','are','be','was','were','which','who','whom','his','her','their','our','your'
    ]);
    const hasHeb = (s: string) => /[\u0590-\u05FF]/.test(s);
    const topKeywords = (text: string, k = 5) => {
      const counts = new Map<string, number>();
      for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
        const w = raw.trim();
        if (!w || hasHeb(w) || w.length < 3 || stopwords.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
      return Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,k).map(([w])=>w);
    };

    const items: any[] = [];
    for (const name of requested) {
      const key = norm(name);
      const ln = bestByName.get(key);
      if (!ln) {
        items.push({ name: String(name), available: false, summaryEn: 'not available' });
        continue;
      }
      const cref = refOf(ln);
      let quoteEn = '';
      let quoteHe = '';
      try {
        const u = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(cref)}`);
        u.searchParams.append('version', 'english');
        u.searchParams.append('version', 'hebrew');
        u.searchParams.append('return_format', 'text_only');
        const j: any = await fetchJsonWithRetry(u);
        const findLang = (arr: any[], targets: string[]) => arr?.find((v: any) => targets.includes(String(v.actualLanguage || v.language || '').toLowerCase()));
        const en = flattenText(findLang(j?.versions || [], ['en','english'])?.text || '');
        const he = flattenText(findLang(j?.versions || [], ['he','hebrew'])?.text || '');
        quoteEn = en ? en.slice(0, maxChars) : '';
        quoteHe = he ? he.slice(0, maxChars) : '';
      } catch {}
      const summaryEn = quoteEn.split(/(?<=[.!?])\s+/)[0]?.slice(0, 200) || (quoteEn || '').slice(0, 200) || undefined;
      const themes = quoteEn ? topKeywords(quoteEn, 5) : undefined;
      items.push({
        name: String(name),
        available: true,
        ref: cref,
        url: toSefariaUrlFromRef(cref),
        quoteEn: quoteEn || undefined,
        quoteHe: quoteHe || undefined,
        summaryEn,
        themes
      });
    }

    const payload = { ref: normRef, url: toSefariaUrlFromRef(normRef), items };
    setCache(cacheKey, payload, 6 * 60_000);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
);

// Smart Calendrical Alerts for next 7 days
server.registerTool(
  'calendar_insights',
  {
    title: 'Calendar Insights',
    description: 'Upcoming 7-day alerts: parsha, chag, daf milestones, with recommended sources and halacha checklist',
    inputSchema: {
      startDate: z.string().regex(/\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD format').optional(),
      diaspora: z.boolean().optional(),
      includeLearningTracks: z.boolean().optional(),
      interests: z.array(z.string()).optional(),
      timezone: z.string().optional()
    },
    outputSchema: {
      startDate: z.string(),
      endDate: z.string(),
      alerts: z.array(
        z.object({
          date: z.string(),
          items: z.array(
            z.object({
              type: z.string(),
              title: z.string(),
              ref: z.string().optional(),
              url: z.string().url().optional(),
              recommendedSources: z.array(z.object({ title: z.string(), ref: z.string().optional(), url: z.string().url().optional() })).optional(),
              halachaChecklist: z.array(z.string()).optional()
            })
          )
        })
      )
    }
  },
  async ({ startDate, diaspora = true, includeLearningTracks = true, interests, timezone }) => {
    const start = startDate ? new Date(startDate + 'T00:00:00Z') : new Date();
    const key = `cal:${start.toISOString().slice(0,10)}:${diaspora}:${includeLearningTracks}:${(interests||[]).join(',')}:${timezone||''}`;
    const cached = getCache<any>(key);
    if (cached) return { content: [{ type: 'text', text: JSON.stringify(cached) }], structuredContent: cached };

    const classify = (item: any): string => {
      const titleEn = String(item?.title?.en || item?.title || '').toLowerCase();
      const cat = String(item?.category || '').toLowerCase();
      if (titleEn.includes('parashat hashavua')) return 'parsha';
      if (titleEn.startsWith('haftarah')) return 'haftarah';
      if (titleEn.includes('rosh chodesh') || titleEn.includes('rosh hodesh')) return 'rosh_chodesh';
      if (titleEn.includes('fast') || titleEn.includes('tzom')) return 'fast';
      if (titleEn.includes('shabbat')) return 'shabbat';
      if (cat.includes('holiday') || ['rosh hashanah','yom kippur','sukkot','pesach','passover','shavuot','purim','chanukah','hanukkah','simchat torah','shemini atzeret'].some(h => titleEn.includes(h))) return 'chag';
      if (titleEn.includes('daf yomi') || titleEn.includes('yomi')) return 'daf';
      return 'other';
    };

    const halachaChecklistFor = (type: string): string[] | undefined => {
      switch (type) {
        case 'shabbat':
          return ['Candle lighting', 'Eruv check', 'Food prep before Shabbat', 'Havdalah'];
        case 'fast':
          return ['Start/End times', 'Health exemptions', 'Hydration plan'];
        case 'chag':
          return ['Kiddush/Challah', 'Eruv Tavshilin (if Fri chag → Shabbat)', 'Hallel where applicable'];
        case 'rosh_chodesh':
          return ['Ya’aleh V’Yavo', 'Hallel (partial/full as applicable)'];
        default:
          return undefined;
      }
    };

    const alerts: any[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const url = new URL('https://www.sefaria.org/api/calendars');
      url.searchParams.set('year', String(yyyy));
      url.searchParams.set('month', String(mm));
      url.searchParams.set('day', String(dd));
      if (typeof diaspora === 'boolean') url.searchParams.set('diaspora', diaspora ? '1' : '0');
      if (timezone) url.searchParams.set('timezone', timezone);
      const j: any = await fetchJsonWithRetry(url).catch(() => ({}));
      const items: any[] = Array.isArray(j?.calendar_items) ? j.calendar_items : [];
      const dayItems: any[] = [];
      for (const item of items) {
        const type = classify(item);
        if (Array.isArray(interests) && interests.length > 0) {
          if (!interests.some(tag => type.includes(String(tag).toLowerCase()))) continue;
        }
        const rec: any = { type, title: String(item?.title?.en || item?.title || item?.displayValue?.en || item?.displayValue || 'Calendar') };
        if (item?.ref) rec.ref = normalizeRef(String(item.ref));
        if (item?.url) rec.url = toSefariaUrlFromRef(String(item.url).replace(/_/g, ' '));
        const rs: any[] = [];
        if (type === 'parsha') {
          rs.push({ title: rec.title, ref: rec.ref, url: rec.url });
        }
        if (includeLearningTracks && (type === 'daf' || (item?.title?.en || '').toLowerCase().includes('yomi'))) {
          rs.push({ title: String(item?.displayValue?.en || item?.displayValue || ''), ref: item?.ref || item?.url, url: rec.url || (item?.url ? toSefariaUrlFromRef(item.url) : undefined) });
        }
        if (rs.length) rec.recommendedSources = rs.filter((e: any) => e.title && (e.ref || e.url));
        const checklist = halachaChecklistFor(type);
        if (checklist) rec.halachaChecklist = checklist;
        dayItems.push(rec);
      }
      alerts.push({ date: `${yyyy}-${mm}-${dd}`, items: dayItems });
    }

    const payload = { startDate: start.toISOString().slice(0,10), endDate: alerts[alerts.length-1].date, alerts };
    setCache(key, payload, 60 * 60_000);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
);

// HTTP server (Streamable HTTP transport)
export const app = express();
app.use(express.json({ limit: '1mb' }));

const cfg = config.util.toObject(config);
const logLevel = process.env.LOG_LEVEL || cfg.logLevel || 'info';
const logger = pino({ level: logLevel });

app.use((pinoHttp as any)({
  logger,
  genReqId: (req: any) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
}));

// Optional API key auth for production
const REQUIRED_API_KEY = (process.env.MCP_API_KEY || '').trim();
function maybeRequireApiKey(req: Request, res: Response, next: Function) {
  const requireKey = REQUIRED_API_KEY || cfg.api?.requireKey;
  if (!requireKey) return next();
  const provided = (req.headers['x-api-key'] as string) || '';
  if (provided && (!REQUIRED_API_KEY || provided === REQUIRED_API_KEY)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
const DASHBOARD_HTML = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Torah MCP Dashboard</title>',
  '<style>body{font-family:Arial, sans-serif;margin:20px;background:#f3f4f6;color:#111}h1{margin-bottom:0.5rem}section{background:#fff;padding:1rem;border-radius:8px;margin-bottom:1rem;box-shadow:0 1px 3px rgba(0,0,0,0.1)}table{width:100%;border-collapse:collapse}th,td{padding:0.5rem;text-align:left;border-bottom:1px solid #e5e7eb}code{background:#e5e7eb;padding:2px 4px;border-radius:4px}</style>',
  '</head><body><h1>Torah MCP Dashboard</h1><p>Updated <span id="timestamp"></span></p>',
  '<section><h2>Summary</h2><div id="summary"></div></section>',
  '<section><h2>Tool Counts</h2><table><thead><tr><th>Tool</th><th>Calls</th></tr></thead><tbody id="tools"></tbody></table></section>',
  '<section><h2>Cache</h2><div id="cache"></div></section>',
  '<section><h2>Python Chains</h2><div id="python"></div></section>',
  '<section><h2>Counters</h2><div id="counters"></div></section>',
  "<script>async function load(){try{const res=await fetch(\"/healthz\");const data=await res.json();const fmt=(n)=>typeof n===\"number\"?n.toLocaleString():n;document.getElementById(\"timestamp\").textContent=new Date().toLocaleTimeString();document.getElementById(\"summary\").innerHTML=\"<strong>Requests:</strong> \"+fmt(data.requests)+\"<br/><strong>Avg latency:</strong> \"+fmt(data.avgLatencyMs)+\" ms<br/><strong>Errors:</strong> \"+fmt(data.errors);const tools=Object.entries(data.toolCounts||{}).sort((a,b)=>b[1]-a[1]);document.getElementById(\"tools\").innerHTML=tools.length?tools.map(([name,count])=>\"<tr><td>\"+name+\"</td><td>\"+fmt(count)+\"</td></tr>\").join(\"\"):\"<tr><td colspan=\\\"2\\\">No tool calls yet</td></tr>\";document.getElementById(\"cache\").innerHTML=\"<strong>Entries:</strong> \"+fmt(data.cacheSize);const py=data.pythonChains||{};document.getElementById(\"python\").innerHTML=\"<strong>Status:</strong> \"+(py.status||\"unknown\")+\"<br/><strong>Last check:</strong> \"+(py.checkedAt?new Date(py.checkedAt).toLocaleString():\"n/a\");const ctrs=data.counters||{};document.getElementById(\"counters\").innerHTML=Object.entries(ctrs).map(([k,v])=>\"<div><strong>\"+k+\":</strong> \"+fmt(v)+\"</div>\").join(\"\");}catch(err){document.body.innerHTML+=\"<p style=\\\"color:red\\\">Failed to load metrics</p>\";}}load();setInterval(load,5000);</script>",
  '</body></html>'
].join('');

// Health counters
const counters = { fetches: 0, cacheHits: 0, robotsBlocked: 0, errors: 0 };
// Basic metrics
const metrics = {
  totalRequests: 0,
  toolCounts: {} as Record<string, number>,
  latSumMs: 0,
  latCount: 0,
  errors: 0,
  toolLatencies: {} as Record<string, { sum: number; count: number }>,
};
let pythonChainHeartbeat: { status: 'ok' | 'error'; checkedAt: number } = { status: 'ok', checkedAt: Date.now() };

app.get('/healthz', (_req: Request, res: Response) => {
  const avgLatencyMs = metrics.latCount ? Math.round(metrics.latSumMs / metrics.latCount) : 0;
  const toolLatencyAvg: Record<string, number> = {};
  for (const [name, stat] of Object.entries(metrics.toolLatencies)) {
    toolLatencyAvg[name] = stat.count ? Math.round(stat.sum / stat.count) : 0;
  }
  res.json({
    ok: true,
    uptime: process.uptime(),
    counters,
    requests: metrics.totalRequests,
    avgLatencyMs,
    toolCounts: metrics.toolCounts,
    toolLatencyAvg,
    cacheSize: cache.size,
    pythonChains: pythonChainHeartbeat,
    errors: metrics.errors,
  });
});

app.post('/mcp', maybeRequireApiKey, async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => transport.close());
  try {
    const started = Date.now();
    await server.connect(transport);
    // Track tool name if present
    const toolName = (req.body && req.body.method === 'tools/call' && req.body.params && (req.body.params.name as string)) || undefined;
    await transport.handleRequest(req, res, req.body);
    const ms = Date.now() - started;
    metrics.totalRequests++;
    metrics.latSumMs += ms; metrics.latCount++;
    if (toolName) metrics.toolCounts[toolName] = (metrics.toolCounts[toolName] || 0) + 1;
    if (toolName) {
      const stat = metrics.toolLatencies[toolName] || { sum: 0, count: 0 };
      stat.sum += ms;
      stat.count += 1;
      metrics.toolLatencies[toolName] = stat;
    }
  } catch (err: any) {
    logger.error({ err }, 'MCP error');
    metrics.errors++;
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

app.get(['/mcp/sse', '/mcp/sse/'], maybeRequireApiKey, async (_req: Request, res: Response) => {
  try {
    const transport = new SSEServerTransport('/mcp/messages', res);
    const sid = transport.sessionId;
    sefariaSseTransports[sid] = transport;
    sefariaSseHeartbeats[sid] = setInterval(() => {
      server.sendLoggingMessage({ level: 'debug', data: 'ping' }, sid).catch(() => {});
    }, 25000);
    transport.onclose = () => {
      delete sefariaSseTransports[sid];
      const h = sefariaSseHeartbeats[sid];
      if (h) { clearInterval(h); delete sefariaSseHeartbeats[sid]; }
    };
    await server.connect(transport);
  } catch (err) {
    logger.error({ err }, 'Sefaria MCP SSE init error');
    if (!res.headersSent) res.status(500).send('Error establishing SSE stream');
  }
});

app.post('/mcp/messages', maybeRequireApiKey, async (req: Request, res: Response) => {
  const sessionId = String((req.query as any).sessionId || '');
  if (!sessionId) return res.status(400).send('Missing sessionId parameter');
  const transport = sefariaSseTransports[sessionId];
  if (!transport) return res.status(404).send('Session not found');
  try {
    await transport.handlePostMessage(req as any, res as any, (req as any).body);
  } catch (err) {
    logger.error({ err }, 'Sefaria MCP SSE message error');
    metrics.errors++;
    if (!res.headersSent) res.status(500).send('Error handling request');
  }
});

// --- Web research MCP: search + fetch (generic web) ---
// Environment/config
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const webCfg = cfg.web ?? {};
const WEB_MAX_RESULTS = Math.min(Math.max(parseInt(process.env.WEB_MAX_RESULTS || `${webCfg.maxResults ?? 10}`, 10) || (webCfg.maxResults ?? 10), 1), 25);
const WEB_MAX_BYTES = Math.min(Math.max(parseInt(process.env.WEB_MAX_BYTES || `${webCfg.maxBytes ?? 2 * 1024 * 1024}`, 10) || (webCfg.maxBytes ?? 2 * 1024 * 1024), 50_000), 10 * 1024 * 1024);
const WEB_MAX_CHARS = Math.min(Math.max(parseInt(process.env.WEB_MAX_CHARS || `${webCfg.maxChars ?? 200_000}`, 10) || (webCfg.maxChars ?? 200_000), 5_000), 1_000_000);
const WEB_TIMEOUT_MS = Math.min(Math.max(parseInt(process.env.WEB_TIMEOUT_MS || `${webCfg.timeoutMs ?? 12_000}`, 10) || (webCfg.timeoutMs ?? 12_000), 3000), 60000);
const WEB_BLOCKLIST = new Set((process.env.WEB_BLOCKLIST || '').split(',').map(s => s.trim()).filter(Boolean));
const WEB_ALLOWLIST = new Set((process.env.WEB_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean));
const WEB_MAX_CONCURRENCY = Math.min(Math.max(parseInt(process.env.WEB_MAX_CONCURRENCY || `${webCfg.maxConcurrency ?? 4}`, 10) || (webCfg.maxConcurrency ?? 4), 1), 16);
const WEB_PER_HOST_CONCURRENCY = Math.min(Math.max(parseInt(process.env.WEB_PER_HOST_CONCURRENCY || `${webCfg.perHostConcurrency ?? 2}`, 10) || (webCfg.perHostConcurrency ?? 2), 1), 8);
const ROBOTS_OBEY = String(process.env.ROBOTS_OBEY ?? `${webCfg.obeyRobots ?? false}`).toLowerCase() === 'true';
const ROBOTS_AGENT = process.env.ROBOTS_USER_AGENT || webCfg.userAgent || 'OpenDeepResearch-MCP/1.0';
const USER_AGENT = ROBOTS_AGENT;
const CACHE_TTL_MS = Math.min(Math.max(parseInt(process.env.CACHE_TTL_MS || `${(cfg.cache?.ttlMs ?? 5 * 60_000)}`, 10) || (cfg.cache?.ttlMs ?? 5 * 60_000), 10_000), 60 * 60_000);
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const WEB_CACHE_MAX_ENTRIES = Math.min(Math.max(parseInt(process.env.WEB_CACHE_MAX_ENTRIES || `${cfg.cache?.maxEntries ?? 200}`, 10) || (cfg.cache?.maxEntries ?? 200), 10), 2000);

const isBlockedHost = (host: string) => WEB_BLOCKLIST.size > 0 && WEB_BLOCKLIST.has(host);
const isAllowedHost = (host: string) => WEB_ALLOWLIST.size === 0 || WEB_ALLOWLIST.has(host);

// Concurrency guard for web fetch (global + per-host)
let webRunning = 0;
const webWaiters: Array<() => void> = [];
const hostRunning = new Map<string, number>();
const hostQueues = new Map<string, Array<() => void>>();
async function acquireWeb(host: string) {
  // Global gate
  if (webRunning >= WEB_MAX_CONCURRENCY) {
    await new Promise<void>(res => webWaiters.push(res));
  }
  webRunning++;
  // Per-host gate
  const current = hostRunning.get(host) || 0;
  if (current >= WEB_PER_HOST_CONCURRENCY) {
    await new Promise<void>(res => {
      const q = hostQueues.get(host) || [];
      q.push(res);
      hostQueues.set(host, q);
    });
  }
  hostRunning.set(host, (hostRunning.get(host) || 0) + 1);
}
function releaseWeb(host: string) {
  const cur = (hostRunning.get(host) || 1) - 1;
  if (cur <= 0) hostRunning.delete(host);
  else hostRunning.set(host, cur);
  const q = hostQueues.get(host);
  if (q && q.length) {
    const next = q.shift();
    if (next) next();
  }
  webRunning = Math.max(0, webRunning - 1);
  const nextGlobal = webWaiters.shift();
  if (nextGlobal) nextGlobal();
}

// Robots.txt allow check (cached per origin)
const robotsCache = new Map<string, any>();
async function isRobotsAllowed(url: URL): Promise<boolean> {
  if (!ROBOTS_OBEY) return true;
  try {
    const key = url.origin;
    let parser = robotsCache.get(key);
    if (!parser) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), Math.min(8000, WEB_TIMEOUT_MS));
      const resp = await fetch(new URL('/robots.txt', url.origin).toString(), { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal } as RequestInit).catch(() => null);
      clearTimeout(t);
      const txt = resp && resp.ok ? await resp.text() : '';
      parser = robotsParser(new URL('/robots.txt', url.origin).toString(), txt || '');
      robotsCache.set(key, parser);
    }
    return parser.isAllowed(url.toString(), ROBOTS_AGENT) !== false;
  } catch {
    return true;
  }
}

// In-memory LRU cache for fetch results
type FetchCacheEntry = {
  url: string;
  title: string;
  text: string;
  metadata: Record<string, any>;
  status: number;
  contentType?: string;
  bytes: number;
  etag?: string;
  lastModified?: string;
  savedAt: number;
};
const fetchCache = new Map<string, FetchCacheEntry>();
function fetchCacheGet(key: string): FetchCacheEntry | undefined {
  const ent = fetchCache.get(key);
  if (!ent) return undefined;
  if (Date.now() - ent.savedAt > CACHE_TTL_MS) { fetchCache.delete(key); return undefined; }
  // refresh LRU
  fetchCache.delete(key); fetchCache.set(key, ent);
  return ent;
}
function fetchCacheSet(key: string, value: FetchCacheEntry) {
  if (fetchCache.has(key)) fetchCache.delete(key);
  fetchCache.set(key, value);
  while (fetchCache.size > WEB_CACHE_MAX_ENTRIES) {
    const first = fetchCache.keys().next().value;
    if (!first) break;
    fetchCache.delete(first);
  }
}

// Register web search tool (Tavily)
webServer.registerTool(
  'search',
  {
    title: 'Web Search',
    description: 'Search the web using Tavily (returns URLs for GPT deep research).',
    inputSchema: { query: z.string().min(1), maxResults: z.number().int().min(1).max(25).optional() },
    outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string().url() })) }
  },
  async ({ query, maxResults }) => {
    const n = Math.min(Math.max(maxResults || WEB_MAX_RESULTS, 1), 25);
    const seen = new Set<string>();
    const out: Array<{ id: string; title: string; url: string }> = [];
    const providers: Array<() => Promise<Array<{ title: string; url: string }>>> = [];
    if (TAVILY_API_KEY) providers.push(async () => {
      const body = { api_key: TAVILY_API_KEY, query, search_depth: 'advanced', max_results: n } as any;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
      const resp = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal } as RequestInit).finally(() => clearTimeout(t));
      if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
      const data: any = await resp.json();
      const arr: any[] = Array.isArray(data?.results) ? data.results : [];
      return arr.map(r => ({ title: String(r.title || r.url || 'Untitled'), url: String(r.url || r.link || '') }));
    });
    if (SERPAPI_KEY) providers.push(async () => {
      const u = new URL('https://serpapi.com/search.json');
      u.searchParams.set('engine', 'google');
      u.searchParams.set('q', query);
      u.searchParams.set('api_key', SERPAPI_KEY);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
      const resp = await fetch(u.toString(), { signal: controller.signal } as RequestInit).finally(() => clearTimeout(t));
      if (!resp.ok) throw new Error(`SerpAPI HTTP ${resp.status}`);
      const data: any = await resp.json();
      const arr: any[] = Array.isArray(data?.organic_results) ? data.organic_results : [];
      return arr.map(r => ({ title: String(r.title || r.link || 'Untitled'), url: String(r.link || r.url || '') }));
    });
    if (BRAVE_API_KEY) providers.push(async () => {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query);
      u.searchParams.set('count', String(n));
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
      const resp = await fetch(u.toString(), { headers: { 'X-Subscription-Token': BRAVE_API_KEY }, signal: controller.signal } as RequestInit).finally(() => clearTimeout(t));
      if (!resp.ok) throw new Error(`Brave HTTP ${resp.status}`);
      const data: any = await resp.json();
      const arr: any[] = Array.isArray(data?.web?.results) ? data.web.results : [];
      return arr.map((r: any) => ({ title: String(r.title || r.url || 'Untitled'), url: String(r.url || '') }));
    });
    // Try providers in order, append until we reach n
    for (const p of providers.length ? providers : [async () => []]) {
      try {
        const arr = await p();
        for (const r of arr) {
          try {
            const u = new URL(r.url);
            if (isBlockedHost(u.hostname) || !isAllowedHost(u.hostname)) continue;
            const key = u.origin + u.pathname; // rough canonicalization
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ id: u.toString(), title: r.title || 'Untitled', url: u.toString() });
            if (out.length >= n) break;
          } catch {}
        }
        if (out.length >= n) break;
      } catch (err) {
        // fallback to next provider
        continue;
      }
    }
    const payload = { results: out.slice(0, n) };
    console.log(JSON.stringify({ event: 'web_search', query, results: payload.results.length }));
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
);

// Register web fetch tool
webServer.registerTool(
  'fetch',
  {
    title: 'Web Fetch',
    description: 'Fetch a URL and return extracted text for GPT to read and cite.',
    inputSchema: { id: z.string().url(), maxChars: z.number().int().min(1000).max(1_000_000).optional() },
    outputSchema: { id: z.string(), title: z.string(), text: z.string(), url: z.string().url(), metadata: z.record(z.any()).optional() }
  },
  async ({ id, maxChars }) => {
    let u0: URL;
    try { u0 = new URL(id); } catch { throw new Error('id must be a valid URL'); }
    if (u0.username || u0.password) throw new Error('URL with credentials not allowed');
    if (!['http:', 'https:'].includes(u0.protocol)) throw new Error('Only http/https URLs are supported');
    if (isBlockedHost(u0.hostname) || !isAllowedHost(u0.hostname)) throw new Error('URL host is not allowed');
    // Cache check (by raw URL id)
    const cached0 = fetchCacheGet(u0.toString());
    if (cached0) {
      counters.cacheHits++;
      return { content: [{ type: 'text', text: JSON.stringify({ id, title: cached0.title, text: cached0.text, url: id, metadata: cached0.metadata }) }], structuredContent: { id, title: cached0.title, text: cached0.text, url: id, metadata: cached0.metadata } };
    }
    await acquireWeb(u0.hostname);
    const started = Date.now();
    let current = u0;
    const initialScheme = current.protocol;
    const seen = new Set<string>();
    let redirectCount = 0;
    let resp: any;
    let cacheHit = false;
    // manual redirect handling with SSRF checks
    while (true) {
      try {
        const { address } = await dns.lookup(current.hostname).catch(() => ({ address: '' }));
        const ip = address || '';
        if (current.hostname === 'localhost' || isPrivateOrReserved(ip)) { releaseWeb(u0.hostname); throw new Error('Blocked: private or loopback address'); }
      } catch {}
      const allowed = await isRobotsAllowed(current);
      if (!allowed) { counters.robotsBlocked++; releaseWeb(u0.hostname); throw new Error('Blocked by robots.txt'); }
      // Try conditional request if cached
      const cached = fetchCacheGet(current.toString());
      const hdrs: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9'
      };
      if (cached?.etag) hdrs['If-None-Match'] = cached.etag;
      if (cached?.lastModified) hdrs['If-Modified-Since'] = cached.lastModified;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
      const r = await fetch(current.toString(), { method: 'GET', headers: hdrs, redirect: 'manual', signal: controller.signal } as RequestInit).catch((e) => { clearTimeout(t); throw e; });
      clearTimeout(t);
      if ([301,302,303,307,308].includes(r.status)) {
        const loc = r.headers.get('location');
        if (!loc) { resp = r; break; }
        const nextUrl = new URL(loc, current);
        if (isBlockedHost(nextUrl.hostname) || !isAllowedHost(nextUrl.hostname)) { releaseWeb(u0.hostname); throw new Error('URL host is not allowed after redirect'); }
        if (initialScheme === 'https:' && nextUrl.protocol !== 'https:') { releaseWeb(u0.hostname); throw new Error('Blocked insecure redirect'); }
        const abs = nextUrl.toString();
        if (seen.has(abs)) { resp = r; break; }
        seen.add(abs);
        current = nextUrl;
        redirectCount++;
        if (redirectCount > 5) { releaseWeb(u0.hostname); throw new Error('Too many redirects'); }
        continue;
      }
      if (r.status === 304 && cached) {
        cacheHit = true;
        const doc = { id, title: cached.title, text: cached.text, url: id, metadata: cached.metadata };
        console.log(JSON.stringify({ event: 'web_fetch', url: id, host: current.hostname, status: 304, bytes: cached.bytes, ms: Date.now() - started, cacheHit: true }));
        releaseWeb(u0.hostname);
        counters.cacheHits++;
        return { content: [{ type: 'text', text: JSON.stringify(doc) }], structuredContent: doc };
      }
      resp = r; break;
    }
    if (!resp || !resp.ok) { counters.errors++; releaseWeb(u0.hostname); throw new Error(`HTTP ${resp?.status || 0}`); }
    const ct = String(resp.headers.get('content-type') || '').toLowerCase();
    let title = 'Untitled';
    let text = '';
    let bytes = 0;
    let canonicalUrl: string | undefined;
    let language: string | undefined;
    let metaPageCount: number | undefined;
    try {
      if (ct.includes('application/pdf') || current.pathname.toLowerCase().endsWith('.pdf')) {
        const ab = await resp.arrayBuffer();
        const buf = Buffer.from(ab);
        bytes = buf.length;
        let pdf: any = null;
        try { pdf = await pdfParse(buf); } catch {}
        if (pdf && (pdf.text || '').trim()) {
          title = 'PDF Document';
          text = String(pdf.text || '');
          if (typeof pdf.numpages === 'number') metaPageCount = pdf.numpages;
        } else {
          const pdfjs: any = await import('pdfjs-dist/build/pdf.mjs');
          const loadingTask = pdfjs.getDocument({ data: buf });
          const doc = await loadingTask.promise;
          let out = '';
          for (let i = 1; i <= Math.min(doc.numPages, 50); i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const strings = (content.items || []).map((it: any) => it.str).join(' ');
            out += strings + '\n\n';
          }
          title = 'PDF Document';
          text = out;
          metaPageCount = doc.numPages;
          await doc.destroy();
        }
      } else if (ct.includes('text/html')) {
        let raw = await resp.text();
        if (raw.length > WEB_MAX_BYTES) raw = raw.slice(0, WEB_MAX_BYTES);
        bytes = raw.length;
        const dom = new JSDOM(raw, { url: current.toString() });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        canonicalUrl = getCanonicalUrlFromDoc(dom.window.document, current.toString());
        title = getTitleFromDoc(dom.window.document, raw) || 'Untitled';
        const contentText = (article?.textContent && article.textContent.trim()) || toText(raw);
        text = contentText;
        language = dom.window.document.documentElement?.getAttribute('lang') || undefined;
      } else if (ct.includes('text/plain') || !ct) {
        let raw = await resp.text();
        if (raw.length > WEB_MAX_BYTES) raw = raw.slice(0, WEB_MAX_BYTES);
        bytes = raw.length;
        title = 'Plain Text';
        text = raw;
      } else {
        let raw = await resp.text();
        if (raw.length > WEB_MAX_BYTES) raw = raw.slice(0, WEB_MAX_BYTES);
        bytes = raw.length;
        const dom = new JSDOM(raw, { url: current.toString() });
        canonicalUrl = getCanonicalUrlFromDoc(dom.window.document, current.toString());
        title = getTitleFromDoc(dom.window.document, raw) || 'Unsupported Content';
        text = toText(raw);
      }
    } finally {
      // release after building log
    }
    text = normalizeText(text);
    const limit = Math.min(Math.max(maxChars || WEB_MAX_CHARS, 1000), 1_000_000);
    if (text.length > limit) text = text.slice(0, limit);
    const meta: Record<string, any> = { contentType: ct || undefined, fetchedAt: new Date().toISOString(), bytes };
    if (canonicalUrl) meta.canonicalUrl = canonicalUrl;
    if (language) meta.language = language;
    if (typeof metaPageCount === 'number') meta.pageCount = metaPageCount;
    const doc = { id, title, text, url: id, metadata: meta };
    const etag = resp.headers.get('etag') || undefined;
    const lastModified = resp.headers.get('last-modified') || undefined;
    // Save to cache (prefer canonical)
    const cacheKey = canonicalUrl || current.toString();
    fetchCacheSet(cacheKey, { url: cacheKey, title, text, metadata: meta, status: resp.status, contentType: ct, bytes, etag, lastModified, savedAt: Date.now() });
    console.log(JSON.stringify({ event: 'web_fetch', url: id, host: current.hostname, status: resp.status, bytes, ms: Date.now() - started, cacheHit }));
    counters.fetches++;
    releaseWeb(u0.hostname);
    return { content: [{ type: 'text', text: JSON.stringify(doc) }], structuredContent: doc };
  }
);

// Rate limiting for MCP endpoints
const rateLimitMax = Number(process.env.MCP_RATE_LIMIT_MAX ?? cfg.rateLimit?.max ?? 60);
const rateLimitWindow = Number(process.env.MCP_RATE_LIMIT_WINDOW_MS ?? cfg.rateLimit?.windowMs ?? 60_000);
export const mcpLimiter = rateLimit({ windowMs: rateLimitWindow, limit: rateLimitMax, standardHeaders: 'draft-7', legacyHeaders: false });
app.use(['/mcp', '/mcp/sse', '/mcp/messages', '/mcp-web', '/mcp-web/sse', '/mcp-web/messages'], mcpLimiter);

// Simple image proxy (optional) – enforces content-type and size; helpful for hosts that need a stable URL
app.get('/image-proxy', async (req: Request, res: Response) => {
  try {
    const url = String((req.query as any).url || '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const loaded = await loadImageAsDataUrl(url);
    const b64 = loaded.dataUrl.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', loaded.mime);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(buf);
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post('/health/python', maybeRequireApiKey, (req: Request, res: Response) => {
  const status = typeof req.body?.status === 'string' && req.body.status.toLowerCase() === 'error' ? 'error' : 'ok';
  pythonChainHeartbeat = { status, checkedAt: Date.now() };
  res.status(204).end();
});

// Dashboard view
app.get('/dashboard', (_req: Request, res: Response) => {
  res.type('html').send(DASHBOARD_HTML);
});

app.post('/mcp-web', maybeRequireApiKey, async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => transport.close());
  try {
    const started = Date.now();
    await webServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    const ms = Date.now() - started;
    metrics.totalRequests++;
    metrics.latSumMs += ms; metrics.latCount++;
    const toolName = (req.body && req.body.method === 'tools/call' && req.body.params && (req.body.params.name as string)) || undefined;
    if (toolName) {
      metrics.toolCounts[toolName] = (metrics.toolCounts[toolName] || 0) + 1;
      const stat = metrics.toolLatencies[toolName] || { sum: 0, count: 0 };
      stat.sum += ms;
      stat.count += 1;
      metrics.toolLatencies[toolName] = stat;
    }
  } catch (err: any) {
    logger.error({ err }, 'Web MCP error');
    metrics.errors++;
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

// Deprecated HTTP+SSE transport for ChatGPT connectors compatibility
app.get(['/mcp-web/sse', '/mcp-web/sse/'], maybeRequireApiKey, async (_req: Request, res: Response) => {
  try {
    const transport = new SSEServerTransport('/mcp-web/messages', res);
    webSseTransports[transport.sessionId] = transport;
    const sid = transport.sessionId;
    webSseHeartbeats[sid] = setInterval(() => {
      webServer.sendLoggingMessage({ level: 'debug', data: 'ping' }, sid).catch(() => {});
    }, 25000);
    transport.onclose = () => {
      delete webSseTransports[sid];
      const h = webSseHeartbeats[sid];
      if (h) { clearInterval(h); delete webSseHeartbeats[sid]; }
    };
    await webServer.connect(transport);
  } catch (err) {
    logger.error({ err }, 'Web MCP SSE init error');
    if (!res.headersSent) res.status(500).send('Error establishing SSE stream');
  }
});

app.post('/mcp-web/messages', maybeRequireApiKey, async (req: Request, res: Response) => {
  const sessionId = String((req.query as any).sessionId || '');
  if (!sessionId) return res.status(400).send('Missing sessionId parameter');
  const transport = webSseTransports[sessionId];
  if (!transport) return res.status(404).send('Session not found');
  try {
    await transport.handlePostMessage(req as any, res as any, (req as any).body);
  } catch (err) {
    logger.error({ err }, 'Web MCP SSE message error');
    metrics.errors++;
    if (!res.headersSent) res.status(500).send('Error handling request');
  }
});

const port = parseInt(process.env.PORT || cfg.port || '3000', 10);
if (!process.env.NO_LISTEN) {
  app.listen(port, () => {
    logger.info(`Torah MCP running at http://localhost:${port}/mcp`);
    logger.info(`Torah MCP SSE (for ChatGPT connectors):`);
    logger.info(`  SSE:       http://localhost:${port}/mcp/sse/`);
    logger.info(`  Messages:  http://localhost:${port}/mcp/messages`);
    logger.info(`Web Research MCP running at http://localhost:${port}/mcp-web`);
    logger.info(`Web Research MCP SSE (for ChatGPT connectors):`);
    logger.info(`  SSE:       http://localhost:${port}/mcp-web/sse/`);
    logger.info(`  Messages:  http://localhost:${port}/mcp-web/messages`);
    logger.info({
      event: 'web_mcp_config',
      ROBOTS_OBEY,
      WEB_MAX_RESULTS,
      WEB_MAX_BYTES,
      WEB_MAX_CHARS,
      WEB_TIMEOUT_MS,
      WEB_MAX_CONCURRENCY,
      WEB_PER_HOST_CONCURRENCY,
      CACHE_TTL_MS,
      WEB_CACHE_MAX_ENTRIES,
      providers: { tavily: !!TAVILY_API_KEY, serpapi: !!SERPAPI_KEY, brave: !!BRAVE_API_KEY }
    }, 'Config');
  });
}

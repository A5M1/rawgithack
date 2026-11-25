// Vercel adapter for rawgithack.
//
// Mirrors the behaviour of rawgithack.conf: it resolves the requested host to
// a source-code origin, proxies the file, rewrites Content-Type/Cache-Control,
// and shows the phishing confirmation page for HTML documents.

import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  CACHE_CONTROL,
  baseDomain,
  cacheControlFor,
  cacheTagFor,
  canonicalHost,
  cdnCacheControlFor,
  contentTypeFor,
  extensionOf,
  hotStatusFor,
  isDirectoryPath,
  isFileLikePath,
  resolveHost,
} from './config.js';
import { renderTemplate } from './ssi.js';

const WEB_ROOT = process.env.GITHACK_WEB_ROOT
  || path.join(process.cwd(), 'web');

const PHISH_COOKIE = '__Http-phish';
const PHISH_HTML = 'internal/phishing-notice.html';
const ERROR_HTML = 'internal/error.html';

function isDeploymentHost(hostname) {
  return process.env.VERCEL_ENV === 'preview'
    || process.env.VERCEL_ENV === 'development'
    || hostname.endsWith('.vercel.app')
    || hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1';
}

function hasPhishCookie(cookieHeader) {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(';')
    .some((part) => part.trim().startsWith(`${PHISH_COOKIE}=`));
}

function refererMatches(referer, host, requestUri) {
  if (!referer) return false;
  try {
    const url = new URL(referer);
    return `${url.host}${url.pathname}${url.search}` === `${host}${requestUri}`;
  } catch {
    return false;
  }
}

function repoPathFor(pathname) {
  const match = pathname.match(/^\/[^/]+\/[^/]+\//);
  return match ? match[0] : '/';
}

function applyCacheHeaders(headers, cacheControl, tag) {
  headers['Cache-Control'] = cacheControl;

  const cdnCacheControl = cdnCacheControlFor(cacheControl);
  if (cdnCacheControl) {
    headers['CDN-Cache-Control'] = cdnCacheControl;
    if (tag) headers['Vercel-Cache-Tag'] = tag;
  }
}

function send(res, status, headers, body) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  }
  res.end(body);
}

async function render(webRoot, template, vars) {
  return renderTemplate(webRoot, template, vars);
}

async function sendError(res, status, vars, tag) {
  let body;
  try {
    body = await render(WEB_ROOT, ERROR_HTML, {
      ...vars,
      status: String(status),
      title: `Error ${status}`,
      description: `rawgit.hack - Error ${status}`,
    });
  } catch {
    body = `<!doctype html><title>Error ${status}</title><p>Error ${status}</p>`;
  }

  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  applyCacheHeaders(headers, cacheControlFor({ status }), tag);
  send(res, status, headers, body);
}

async function sendPhishingNotice(req, res, vars) {
  const body = await render(WEB_ROOT, PHISH_HTML, vars);
  send(res, 460, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': CACHE_CONTROL.none,
    Vary: 'Cookie',
  }, body);
}

function upstreamRequestHeaders(req) {
  const headers = {};

  for (const name of [
    'accept',
    'accept-language',
    'if-none-match',
    'if-modified-since',
    'range',
    'user-agent',
  ]) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  return headers;
}

async function proxyFile(req, res, options, context) {
  const { origin, isCdn, contentType, pathname, search, tag, vars } = context;
  const { fetchImpl } = options;
  const target = `https://${origin}${pathname}${search}`;

  let upstream;
  try {
    upstream = await fetchImpl(target, {
      method: 'GET',
      headers: upstreamRequestHeaders(req),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    await sendError(res, 502, vars, tag);
    return;
  }

  if (upstream.status >= 400) {
    await upstream.body?.cancel();
    await sendError(res, upstream.status, vars, tag);
    return;
  }

  const upstreamContentType = upstream.headers.get('content-type') || '';
  const hotStatus = !isCdn && !(contentType && contentType.startsWith('text/html'))
    ? hotStatusFor(`${origin}${pathname}`)
    : undefined;

  // A content-type is always determined by the extension, exactly like the
  // nginx config does. Fall back to the upstream type only for redirects that
  // we cannot classify ourselves.
  const responseType = contentType
    || (upstream.status >= 300 && upstream.status < 400
      ? upstreamContentType
      : 'application/octet-stream');

  const headers = {
    'Content-Type': responseType,
    'X-Robots-Tag': 'none',
    'Access-Control-Allow-Origin': '*',
  };

  if (contentType) {
    applyCacheHeaders(
      headers,
      cacheControlFor({
        status: upstream.status,
        isCdn,
        contentType,
        hotStatus,
      }),
      tag,
    );
  } else {
    applyCacheHeaders(
      headers,
      cacheControlFor({ status: upstream.status, isCdn, contentType }),
      tag,
    );
  }

  for (const name of ['accept-ranges', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  const location = upstream.headers.get('location');
  if (location && location.startsWith(`https://${origin}`)) {
    const scheme = req.headers['x-forwarded-proto'] || 'https';
    headers.Location = location.replace(
      `https://${origin}`,
      `${scheme}://${vars.http_host}`,
    );
  } else if (location) {
    headers.Location = location;
  }

  res.statusCode = upstream.status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    // The client may disconnect mid-stream; nothing useful can be sent now.
  }
}

async function sendIndex(req, res, context) {
  const body = await render(WEB_ROOT, 'index.html', context.vars);
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  applyCacheHeaders(headers, CACHE_CONTROL.index, context.tag);
  send(res, 200, headers, body);
}

async function handlePurge(req, res) {
  if (req.method !== 'DELETE') {
    send(res, 405, { Allow: 'DELETE', 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const url = new URL(req.url, 'https://localhost');
  const target = url.searchParams.get('url');
  if (!target) {
    send(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'missing url parameter' }));
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    send(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'invalid url parameter' }));
    return;
  }

  const hostname = parsed.hostname.toLowerCase();
  const resolved = resolveHost(hostname);
  const origin = resolved.origin || hostname;
  const filePath = isDirectoryPath(parsed.pathname)
    ? `${parsed.pathname}index.html`
    : parsed.pathname;
  const tag = cacheTagFor(origin, filePath);

  try {
    const { invalidateByTag } = await import('@vercel/functions');
    await invalidateByTag(tag);
    send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ purged: tag }));
  } catch (error) {
    send(res, 501, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({
        error: 'cache invalidation is only available on Vercel',
        detail: String(error?.message || error),
      }));
  }
}

/**
 * Node request handler. Exported separately so tests (and `vercel dev`) can
 * call it without going through the platform.
 */
export async function handle(req, res, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const base = baseDomain();
  const canonical = canonicalHost();
  const hostHeader = req.headers.host || 'localhost';
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  const requestUri = req.url || '/';
  const url = new URL(requestUri, `http://${hostHeader}`);
  const { pathname, search } = url;
  const scheme = req.headers['x-forwarded-proto']
    || (req.socket?.encrypted ? 'https' : 'http');

  if (pathname === '/purge' || pathname === '/purge/') {
    await handlePurge(req, res);
    return;
  }

  let resolved = resolveHost(hostname);

  if (!resolved.known) {
    if (!isDeploymentHost(hostname)) {
      send(res, 301, { Location: `https://${canonical}${requestUri}` }, '');
      return;
    }

    // Preview/deployment domains act as the development raw host so the
    // project can be exercised before custom domains are attached.
    resolved = { known: false, origin: 'raw.githubusercontent.com', isCdn: false };
  }

  const context = {
    origin: resolved.origin,
    isCdn: resolved.isCdn,
    pathname,
    search,
    tag: cacheTagFor(resolved.origin, pathname),
    vars: {
      request_uri: requestUri,
      http_host: hostHeader,
      rg_origin: resolved.origin,
      rg_base_domain: base,
      rg_canonical_host: canonical,
    },
  };

  // merge_slashes: nginx issues a redirect, we collapse all runs at once.
  if (pathname.includes('//')) {
    const collapsed = pathname.replace(/\/{2,}/g, '/');
    send(res, 301, { Location: `${scheme}://${hostHeader}${collapsed}${search}` }, '');
    return;
  }

  // rewrite ^/index(\.html)?$ / permanent;
  if (/^\/index(?:\.html)?$/.test(pathname)) {
    send(res, 301, { Location: `${scheme}://${hostHeader}/` }, '');
    return;
  }

  if (pathname === '/') {
    if (resolved.known && hostname !== canonical) {
      send(res, 301, { Location: `https://${canonical}/${search}` }, '');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 403, { 'Content-Type': 'text/html; charset=utf-8' }, '');
      return;
    }

    await sendIndex(req, res, context);
    return;
  }

  // Location /internal/ is internal in nginx.
  if (pathname.startsWith('/internal/')) {
    await sendError(res, 404, context.vars, context.tag);
    return;
  }

  // Directory URLs are rewritten to index.html.
  let filePath = pathname;
  if (isDirectoryPath(filePath)) filePath += 'index.html';

  if (!isFileLikePath(filePath)) {
    await sendError(res, 404, context.vars, context.tag);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    send(res, 403, { 'Content-Type': 'text/html; charset=utf-8' }, '');
    return;
  }

  context.pathname = filePath;
  context.tag = cacheTagFor(resolved.origin, filePath);

  if (req.method === 'POST') {
    if (!refererMatches(req.headers.referer, hostHeader, requestUri)) {
      send(res, 403, { 'Content-Type': 'text/html; charset=utf-8' }, '');
      return;
    }

    send(res, 303, {
      Location: `https://${hostHeader}${requestUri}`,
      'Cache-Control': CACHE_CONTROL.none,
      'Set-Cookie': `${PHISH_COOKIE}=1; Path=${repoPathFor(filePath)}; `
        + 'Max-Age=86400; SameSite=Lax; HttpOnly; Secure',
    }, '');
    return;
  }

  const extension = extensionOf(filePath);
  const contentType = contentTypeFor(extension);

  // Unknown extension: redirect to the origin so the browser handles it.
  if (!contentType) {
    const headers = {
      Location: `https://${resolved.origin}${requestUri}`,
      'X-Robots-Tag': 'none',
      'Access-Control-Allow-Origin': '*',
    };
    applyCacheHeaders(headers, 'max-age=86400, public', context.tag);
    send(res, 301, headers, '');
    return;
  }

  context.contentType = contentType;

  // HTML documents get a confirmation notice unless the cookie is present.
  if (
    contentType.startsWith('text/html')
    && req.headers['sec-fetch-dest'] === 'document'
    && !hasPhishCookie(req.headers.cookie)
  ) {
    await sendPhishingNotice(req, res, context.vars);
    return;
  }

  await proxyFile(req, res, { fetchImpl }, context);
}

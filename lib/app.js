// Vercel adapter for rawgithack.
//
// Implements the upstream proxy behaviour: it resolves the requested host to
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
  prefixForOrigin,
  resolveHost,
  resolvePathPrefix,
} from './config.js';
import { renderTemplate } from './ssi.js';
import { getStore } from './db.js';
import {
  clearSessionCookies,
  hashPassword,
  hashSessionToken,
  isSafeRedirect,
  isUsername,
  isReservedUsername,
  newInviteToken,
  newSessionToken,
  parseCookies,
  SESSION_COOKIE,
  HOST_SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookie,
  secretsMatch,
  verifyPassword,
} from './auth.js';
import { rateLimit } from './ratelimit.js';

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

function publicRepoPathFor(publicPathname, routingPath, singleHost) {
  const repo = repoPathFor(routingPath);
  if (!singleHost) return repo;

  const prefix = publicPathname.split('/')[1]?.toLowerCase();
  if (!prefix || !resolvePathPrefix(prefix)) return repo;

  return `/${prefix}${repo}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isSecureRequest(req) {
  const trustProxy = Boolean(process.env.VERCEL || process.env.TRUST_PROXY === '1');

  if (trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (proto) return proto === 'https';
  }

  return Boolean(req.socket?.encrypted);
}

function clientIp(req) {
  const trustProxy = Boolean(process.env.VERCEL || process.env.TRUST_PROXY === '1');

  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded;
  }

  return req.socket?.remoteAddress || 'unknown';
}

function logSecurityEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({
      type: 'security',
      event,
      at: new Date().toISOString(),
      ...details,
    }));
  } catch {
    // Logging must never break a request.
  }
}

function pageSecurityHeaders() {
  return {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  };
}

const DUMMY_PASSWORD_HASH = 'scrypt$16384$8$1$5b096832f7165510b3dcd67115b2ef6e$056f0ae79c7d0dbc332345be54be7e0124d65bc01133f840909b95959b83e4684e399463b91fe163dfc2c8174efc2b2583269603c2b6989d489fc4738647049d';

function enforceRateLimit(res, key, options, message = 'too many requests') {
  const result = rateLimit(key, options);

  if (!result.allowed) {
    logSecurityEvent('rate_limit', { key, retryAfter: result.retryAfter });
    send(res, 429, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(result.retryAfter),
      'X-Content-Type-Options': 'nosniff',
    }, JSON.stringify({ error: message }));
    return false;
  }

  return true;
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const body = await readBody(req);
  try {
    return JSON.parse(body || '{}');
  } catch {
    const error = new Error('invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

function storeFor(options) {
  return options.store !== undefined ? Promise.resolve(options.store) : getStore();
}

async function currentUser(req, store) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[HOST_SESSION_COOKIE] || cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = await store.getSession(hashSessionToken(token));
  if (!session?.username) return null;

  const user = await store.getUser(session.username);
  if (!user) return null;

  const role = user.role === 'admin' ? 'admin' : 'user';
  return { ...user, role };
}

function isAdmin(user) {
  return user?.role === 'admin';
}

function siteVars(hostContext) {
  return {
    rg_site_name: hostContext.siteName,
    rg_source_url: hostContext.sourceUrl,
  };
}

function loginVars(hostContext, extra = {}) {
  return {
    title: 'Sign in',
    description: `${hostContext.siteName} - sign in`,
    rg_base_domain: hostContext.base,
    rg_canonical_host: hostContext.canonical,
    rg_single_host: hostContext.singleHost ? '1' : '0',
    rg_site_name: hostContext.siteName,
    rg_source_url: hostContext.sourceUrl,
    rg_user: '',
    error: '',
    next: '/',
    ...extra,
  };
}

async function sendLoginPage(res, hostContext, { status = 200, error = '', next = '/' } = {}) {
  const body = await render(WEB_ROOT, 'login.html', loginVars(hostContext, {
    error: escapeHtml(error),
    next: escapeHtml(isSafeRedirect(next)),
  }));

  send(res, status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...pageSecurityHeaders(),
  }, body);
}

async function handleLogin(req, res, options, hostContext) {
  const store = await storeFor(options);
  const url = new URL(req.url, 'https://localhost');
  const next = isSafeRedirect(url.searchParams.get('next') || '/');

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (store) {
      const user = await currentUser(req, store);
      if (user) {
        send(res, 302, { Location: next, 'Cache-Control': 'no-store' }, '');
        return;
      }
    }

    await sendLoginPage(res, hostContext, { next });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { Allow: 'GET, POST', 'Content-Type': 'text/plain' }, 'Method Not Allowed');
    return;
  }

  if (!store) {
    await sendLoginPage(res, hostContext, {
      status: 503,
      error: 'Authentication is not configured (MONGODB_URI is missing).',
    });
    return;
  }

  const params = new URLSearchParams(await readBody(req));
  const username = params.get('username') || '';
  const password = params.get('password') || '';
  const target = isSafeRedirect(params.get('next') || '/');
  const ip = clientIp(req);

  if (!enforceRateLimit(
    res,
    `login-ip:${ip}`,
    { windowMs: 15 * 60 * 1000, max: 60 },
    'too many login attempts',
  )) {
    return;
  }

  if (!enforceRateLimit(
    res,
    `login:${ip}:${username}`,
    { windowMs: 15 * 60 * 1000, max: 10 },
    'too many login attempts',
  )) {
    return;
  }

  if (!isUsername(username) || !password) {
    logSecurityEvent('login_failed', { username, ip, reason: 'invalid_input' });
    await sendLoginPage(res, hostContext, {
      status: 401,
      error: 'Invalid username or password.',
      next: target,
    });
    return;
  }

  const user = await store.getUser(username);
  const valid = await verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);

  if (!valid || !user) {
    logSecurityEvent('login_failed', { username, ip, reason: 'invalid_credentials' });
    await sendLoginPage(res, hostContext, {
      status: 401,
      error: 'Invalid username or password.',
      next: target,
    });
    return;
  }

  logSecurityEvent('login_success', { username, ip });

  const { token, hash } = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await store.createSession(hash, username, expiresAt);

  const destination = target === '/' ? '/dashboard' : target;

  send(res, 303, {
    Location: destination,
    'Set-Cookie': sessionCookie(token, { secure: isSecureRequest(req) }),
    'Cache-Control': 'no-store',
  }, '');
}

async function handleLogout(req, res, options) {
  const store = await storeFor(options);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[HOST_SESSION_COOKIE] || cookies[SESSION_COOKIE];

  if (store && token) {
    await store.deleteSession(hashSessionToken(token));
    logSecurityEvent('logout', { ip: clientIp(req) });
  }

  send(res, 303, {
    Location: '/login',
    'Set-Cookie': clearSessionCookies({ secure: isSecureRequest(req) }),
    'Cache-Control': 'no-store',
  }, '');
}

async function sendRegisterPage(res, hostContext, { status = 200, error = '' } = {}) {
  const body = await render(WEB_ROOT, 'register.html', {
    title: 'Create account',
    description: `${hostContext.siteName} - create account`,
    rg_base_domain: hostContext.base,
    rg_canonical_host: hostContext.canonical,
    rg_single_host: hostContext.singleHost ? '1' : '0',
    rg_site_name: hostContext.siteName,
    rg_source_url: hostContext.sourceUrl,
    rg_user: '',
    error: escapeHtml(error),
  });

  send(res, status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...pageSecurityHeaders(),
  }, body);
}

async function sendRegisterStartPage(res, hostContext) {
  const body = await render(WEB_ROOT, 'register-start.html', {
    title: 'Register',
    description: `${hostContext.siteName} - register`,
    rg_base_domain: hostContext.base,
    rg_canonical_host: hostContext.canonical,
    rg_single_host: hostContext.singleHost ? '1' : '0',
    rg_site_name: hostContext.siteName,
    rg_source_url: hostContext.sourceUrl,
    rg_user: '',
  });

  send(res, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...pageSecurityHeaders(),
  }, body);
}

async function handleRegister(req, res, options, hostContext, token) {
  const store = await storeFor(options);

  if (!store) {
    await sendRegisterPage(res, hostContext, {
      status: 503,
      error: 'Registration is not configured (MONGODB_URI is missing).',
    });
    return;
  }

  const tokenHash = hashSessionToken(token);
  const legacySecret = process.env.REGISTRATION_SECRET;
  const legacy = Boolean(legacySecret && secretsMatch(token, legacySecret));
  let invite = null;

  if (legacy) {
    if (await store.isRegistrationUsed()) {
      await sendError(res, 404, siteVars(hostContext), null);
      return;
    }
  } else {
    invite = await store.getInvite(tokenHash);
    if (!invite || invite.usedAt) {
      await sendError(res, 404, siteVars(hostContext), null);
      return;
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    await sendRegisterPage(res, hostContext);
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { Allow: 'GET, POST', 'Content-Type': 'text/plain' }, 'Method Not Allowed');
    return;
  }

  if (!enforceRateLimit(
    res,
    `register:${clientIp(req)}`,
    { windowMs: 60 * 60 * 1000, max: 20 },
    'too many registration attempts',
  )) {
    return;
  }

  const params = new URLSearchParams(await readBody(req));
  const username = params.get('username') || '';
  const password = params.get('password') || '';
  const confirmation = params.get('confirm') || '';

  if (!isUsername(username)) {
    await sendRegisterPage(res, hostContext, {
      status: 400,
      error: 'Username must be 1-64 characters: letters, numbers, dot, dash or underscore.',
    });
    return;
  }

  if (isReservedUsername(username)) {
    await sendRegisterPage(res, hostContext, {
      status: 400,
      error: 'That username is reserved.',
    });
    return;
  }

  if (password.length < 8) {
    await sendRegisterPage(res, hostContext, {
      status: 400,
      error: 'Password must be at least 8 characters.',
    });
    return;
  }

  if (password !== confirmation) {
    await sendRegisterPage(res, hostContext, {
      status: 400,
      error: 'Passwords do not match.',
    });
    return;
  }

  const reserved = legacy
    ? await store.reserveRegistration(tokenHash)
    : await store.reserveInvite(tokenHash, username);

  if (!reserved) {
    // Another request consumed the link between the read and the reservation.
    await sendError(res, 404, siteVars(hostContext), null);
    return;
  }

  try {
    await store.createUser(username, await hashPassword(password), 'user');
    logSecurityEvent('registration_success', {
      username,
      ip: clientIp(req),
      legacy,
    });
  } catch (error) {
    if (legacy) await store.releaseRegistration(tokenHash);
    else await store.releaseInvite(tokenHash);

    if (error?.code === 11000) {
      await sendRegisterPage(res, hostContext, {
        status: 409,
        error: 'That username is already taken.',
      });
      return;
    }

    await sendRegisterPage(res, hostContext, {
      status: 500,
      error: 'Could not create the account.',
    });
    return;
  }

  const { token: sessionToken, hash } = newSessionToken();
  let cookie = null;

  try {
    await store.createSession(
      hash,
      username,
      new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    );
    cookie = sessionCookie(sessionToken, { secure: isSecureRequest(req) });
  } catch {
    // The account exists; the user can sign in manually.
  }

  const headers = {
    Location: cookie ? '/dashboard' : '/login',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
  if (cookie) headers['Set-Cookie'] = cookie;

  send(res, 303, headers, '');
}

// Convert a public URL on one of our hosts into the fields needed to proxy it.
// Returns null when the URL is not one of ours or not a supported file.
function descriptorForPublicUrl(parsed) {
  const hostname = parsed.hostname.toLowerCase();
  const hostInfo = resolveHost(hostname);
  const deployment = isDeploymentHost(hostname);
  const singleHost = deployment
    && (!hostInfo.known || hostname.endsWith('.vercel.app'));

  let origin = hostInfo.origin;
  let isCdn = hostInfo.isCdn;
  let filePath = parsed.pathname;

  if (!hostInfo.known) {
    if (!singleHost) return null;
    origin = 'raw.githubusercontent.com';
    isCdn = false;
  }

  if (singleHost) {
    const segment = filePath.split('/')[1]?.toLowerCase() ?? '';
    const prefix = resolvePathPrefix(segment);

    if (prefix) {
      origin = prefix.origin;
      isCdn = prefix.isCdn;
      filePath = filePath.slice(segment.length + 1) || '/';
      if (!filePath.startsWith('/')) filePath = `/${filePath}`;
    }
  }

  if (isDirectoryPath(filePath)) filePath += 'index.html';
  if (!isFileLikePath(filePath)) return null;

  const contentType = contentTypeFor(extensionOf(filePath));
  if (!contentType) return null;

  return {
    origin,
    isCdn,
    path: filePath,
    search: parsed.search || '',
    contentType,
    url: parsed.href,
  };
}

// Convert common source-host URLs into the origin + path that the proxy needs.
// This lets the dashboard accept GitHub/GitLab/Bitbucket URLs directly.
function descriptorForSourceUrl(parsed, { cdn = true } = {}) {
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;
  let origin;
  let filePath;

  if (hostname === 'raw.githubusercontent.com') {
    origin = 'raw.githubusercontent.com';
    filePath = pathname;
  } else if (hostname === 'gist.githubusercontent.com') {
    origin = 'gist.githubusercontent.com';
    filePath = pathname;
  } else if (hostname === 'github.com') {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (!match) return null;
    origin = 'raw.githubusercontent.com';
    filePath = `/${match[1]}/${match[2]}/${match[3]}`;
  } else if (hostname === 'gitlab.com') {
    const match = pathname.match(/^\/(.+?)\/(?:-\/)?(?:raw|blob)\/(.+)$/);
    if (!match) return null;
    origin = 'gitlab.com';
    filePath = `/${match[1]}/raw/${match[2]}`;
  } else if (hostname === 'bitbucket.org') {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/(?:raw|src)\/(.+)$/);
    if (!match) return null;
    origin = 'bitbucket.org';
    filePath = `/${match[1]}/${match[2]}/raw/${match[3]}`;
  } else if (hostname === 'gitea.com') {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/(?:raw|src)\/(.+)$/);
    if (!match) return null;
    origin = 'gitea.com';
    filePath = `/${match[1]}/${match[2]}/raw/${match[3]}`;
  } else if (hostname === 'codeberg.org') {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/(?:raw|src)\/(.+)$/);
    if (!match) return null;
    origin = 'codeberg.org';
    filePath = `/${match[1]}/${match[2]}/raw/${match[3]}`;
  } else {
    return null;
  }

  if (isDirectoryPath(filePath)) filePath += 'index.html';
  if (!isFileLikePath(filePath)) return null;

  const contentType = contentTypeFor(extensionOf(filePath));
  if (!contentType) return null;

  return {
    origin,
    isCdn: Boolean(cdn),
    path: filePath,
    search: parsed.search || '',
    contentType,
    url: parsed.href,
  };
}

function legacyPublicUrl(descriptor, hostContext) {
  const prefix = prefixForOrigin(descriptor.origin);
  let host;
  let pathPrefix = '';

  if (hostContext.singleHost) {
    host = hostContext.hostHeader;
    if (prefix === 'raw') {
      pathPrefix = descriptor.isCdn ? 'cdn' : '';
    } else {
      pathPrefix = `${prefix}${descriptor.isCdn ? 'cdn' : ''}`;
    }
  } else if (prefix === 'raw' && !descriptor.isCdn) {
    host = hostContext.canonical;
  } else {
    host = `${prefix}${descriptor.isCdn ? 'cdn' : ''}.${hostContext.base}`;
  }

  return `${hostContext.scheme}://${host}${pathPrefix ? `/${pathPrefix}` : ''}${descriptor.path}${descriptor.search || ''}`;
}

async function handleCreateProxy(req, res, store, user, hostContext) {
  if (req.method !== 'POST') {
    send(res, 405, { Allow: 'POST', 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (!store) {
    send(res, 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ error: 'database is not configured' }));
    return;
  }

  if (!enforceRateLimit(
    res,
    `proxy-create:${user.username}`,
    { windowMs: 60 * 60 * 1000, max: 120 },
    'too many short-link creations',
  )) {
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    send(res, error.statusCode || 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: error.message }));
    return;
  }

  const raw = typeof body.url === 'string' ? body.url.trim() : '';
  if (!raw || raw.length > 2048) {
    send(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'url is required' }));
    return;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    send(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'invalid url' }));
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    send(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'only http(s) urls are supported' }));
    return;
  }

  const descriptor = descriptorForPublicUrl(parsed)
    || descriptorForSourceUrl(parsed, { cdn: body.cdn !== false });
  if (!descriptor) {
    send(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'url is not a supported source URL' }));
    return;
  }

  const customSlug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (customSlug && !/^[A-Za-z0-9_-]{2,64}$/.test(customSlug)) {
    send(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({
        error: 'custom name must be 2-64 characters: letters, numbers, dash or underscore',
      }));
    return;
  }

  if (!customSlug) {
    const legacyUrl = legacyPublicUrl(descriptor, hostContext);

    logSecurityEvent('legacy_url_returned', {
      username: user.username,
      url: legacyUrl,
    });

    send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ legacy: true, shortUrl: legacyUrl, url: parsed.href }));
    return;
  }

  const quota = Number(process.env.SHORT_LINK_QUOTA || 200);
  if (Number.isFinite(quota) && quota > 0) {
    const count = typeof store.countProxies === 'function'
      ? await store.countProxies(user.username)
      : 0;

    if (count >= quota) {
      send(res, 429, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      }, JSON.stringify({ error: 'short-link quota reached' }));
      return;
    }
  }

  const record = {
    ...descriptor,
    owner: user.username,
    createdAt: new Date(),
  };

  const id = customSlug;

  try {
    await store.createProxy({ _id: id, ...record });
  } catch (error) {
    if (error?.code === 11000) {
      send(res, 409, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'that custom short name is already taken' }));
      return;
    }
    throw error;
  }

  const shortUrl = `${hostContext.scheme}://${hostContext.hostHeader}/s/${id}`;
  logSecurityEvent('short_link_created', {
    username: user.username,
    id,
    cdn: Boolean(descriptor.isCdn),
  });
  send(res, 201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    JSON.stringify({ id, shortUrl, url: parsed.href }));
}

function proxyJson(record, hostContext) {
  return {
    id: record._id,
    url: record.url,
    shortUrl: `${hostContext.scheme}://${hostContext.hostHeader}/s/${record._id}`,
    isCdn: Boolean(record.isCdn),
    createdAt: record.createdAt,
  };
}

async function handleListProxies(req, res, store, user, hostContext) {
  if (!store) {
    send(res, 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ error: 'database is not configured' }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { Allow: 'GET, POST', 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const records = await store.listProxies(user.username);
  send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    JSON.stringify({ proxies: records.map((record) => proxyJson(record, hostContext)) }));
}

async function handleDeleteProxy(req, res, store, user, id) {
  if (!store) {
    send(res, 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ error: 'database is not configured' }));
    return;
  }

  const deleted = await store.deleteProxy(id, user.username);
  if (!deleted) {
    send(res, 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ error: 'proxy not found' }));
    return;
  }

  const tag = `p${id}`;
  let purged = false;
  try {
    const { invalidateByTag } = await import('@vercel/functions');
    await invalidateByTag(tag);
    purged = true;
  } catch {
    // Deleting the record is still useful outside Vercel.
  }

  logSecurityEvent('short_link_deleted', {
    username: user.username,
    id,
    purged,
  });

  const status = !purged && process.env.VERCEL ? 502 : 200;
  send(res, status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    JSON.stringify({
      deleted: true,
      purged,
      tag,
      ...(purged ? {} : { warning: 'cache invalidation failed; cached response may persist' }),
    }));
}

async function sendDashboardApp(res, hostContext, user) {
  const body = await render(WEB_ROOT, 'dashboard.html', {
    title: 'Dashboard',
    description: `${hostContext.siteName} - dashboard`,
    rg_base_domain: hostContext.base,
    rg_canonical_host: hostContext.canonical,
    rg_single_host: hostContext.singleHost ? '1' : '0',
    rg_site_name: hostContext.siteName,
    rg_source_url: hostContext.sourceUrl,
    rg_user: user.username,
    rg_role: user.role,
  });

  send(res, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...pageSecurityHeaders(),
  }, body);
}

async function handleAdminApi(req, res, store, user, pathname, hostContext) {
  const json = (status, body) => send(res, status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  }, JSON.stringify(body));

  if (!store) {
    json(503, { error: 'database is not configured' });
    return;
  }

  if (pathname === '/api/admin/users' || pathname === '/api/admin/users/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(405, { error: 'method not allowed' });
      return;
    }

    const users = await store.listUsers();
    json(200, {
      users: users.map((entry) => ({
        username: entry.username,
        role: entry.role === 'admin' ? 'admin' : 'user',
        createdAt: entry.createdAt,
      })),
    });
    return;
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/?$/);
  if (userMatch) {
    const username = decodeURIComponent(userMatch[1]);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const target = await store.getUser(username);
      if (!target) {
        json(404, { error: 'user not found' });
        return;
      }

      const proxies = await store.listProxies(username);
      json(200, {
        user: {
          username: target.username,
          role: target.role === 'admin' ? 'admin' : 'user',
          createdAt: target.createdAt,
        },
        proxies: proxies.map((record) => proxyJson(record, hostContext)),
      });
      return;
    }

    if (req.method === 'PATCH') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(error.statusCode || 400, { error: error.message });
        return;
      }

      const role = body.role === 'admin' ? 'admin' : body.role === 'user' ? 'user' : null;
      if (!role) {
        json(400, { error: 'role must be "admin" or "user"' });
        return;
      }

      if (username === user.username && role !== 'admin') {
        json(400, { error: 'you cannot remove your own admin role' });
        return;
      }

      const changed = await store.setUserRole(username, role);
      if (!changed) {
        json(404, { error: 'user not found' });
        return;
      }

      logSecurityEvent('user_role_changed', {
        actor: user.username,
        username,
        role,
      });

      json(200, { updated: true, username, role });
      return;
    }

    if (req.method === 'DELETE') {
      if (username === user.username) {
        json(400, { error: 'you cannot delete your own account' });
        return;
      }

      const proxies = await store.listProxies(username);
      const deleted = await store.deleteUser(username);
      if (!deleted) {
        json(404, { error: 'user not found' });
        return;
      }

      logSecurityEvent('user_deleted', { actor: user.username, username });

      for (const record of proxies) {
        try {
          const { invalidateByTag } = await import('@vercel/functions');
          await invalidateByTag(`p${record._id}`);
        } catch {
          // Best effort outside Vercel.
        }
      }

      json(200, { deleted: true, username });
      return;
    }

    json(405, { error: 'method not allowed' });
    return;
  }

  if (pathname === '/api/admin/invites' || pathname === '/api/admin/invites/') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const invites = await store.listInvites();
      json(200, {
        invites: invites.map((invite) => ({
          id: invite._id,
          createdBy: invite.createdBy,
          createdAt: invite.createdAt,
          usedAt: invite.usedAt || null,
          usedBy: invite.usedBy || null,
        })),
      });
      return;
    }

    if (req.method === 'POST') {
      if (!enforceRateLimit(
        res,
        `invite-create:${user.username}`,
        { windowMs: 60 * 60 * 1000, max: 30 },
        'too many invite creations',
      )) {
        return;
      }

      const { token, hash } = newInviteToken();
      const createdAt = new Date();
      await store.createInvite({
        _id: hash,
        createdBy: user.username,
        createdAt,
      });

      logSecurityEvent('invite_created', { username: user.username });

      json(201, {
        id: hash,
        url: `${hostContext.scheme}://${hostContext.hostHeader}/register/${token}`,
        createdAt,
      });
      return;
    }

    json(405, { error: 'method not allowed' });
    return;
  }

  const inviteMatch = pathname.match(/^\/api\/admin\/invites\/([A-Za-z0-9_-]{16,128})\/?$/);
  if (inviteMatch) {
    if (req.method !== 'DELETE') {
      json(405, { error: 'method not allowed' });
      return;
    }

    const deleted = await store.deleteInvite(inviteMatch[1]);
    if (deleted) {
      logSecurityEvent('invite_revoked', { actor: user.username, invite: inviteMatch[1] });
    }
    json(deleted ? 200 : 404, deleted
      ? { deleted: true }
      : { error: 'invite not found' });
    return;
  }

  json(404, { error: 'not found' });
}

async function handleShortProxy(req, res, options, hostContext) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
    return;
  }

  const id = new URL(req.url, 'https://localhost').pathname.slice(3);
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) {
    await sendError(res, 404, siteVars(hostContext), null);
    return;
  }

  const store = await storeFor(options);
  const record = store ? await store.getProxy(id) : null;

  if (!record || !record.origin || !record.path) {
    await sendError(res, 404, siteVars(hostContext), null);
    return;
  }

  const contentType = record.contentType
    || contentTypeFor(extensionOf(record.path));

  const context = {
    origin: record.origin,
    isCdn: Boolean(record.isCdn),
    pathname: record.path,
    search: record.search || '',
    contentType,
    tag: `p${id}`,
    vars: {
      request_uri: `/s/${id}`,
      http_host: hostContext.hostHeader,
      rg_origin: record.origin,
      rg_origin_uri: `${record.path}${record.search || ''}`,
      rg_base_domain: hostContext.base,
      rg_canonical_host: hostContext.canonical,
      rg_single_host: hostContext.singleHost ? '1' : '0',
      rg_site_name: hostContext.siteName,
      rg_source_url: hostContext.sourceUrl,
      rg_user: '',
    },
  };

  if (
    contentType?.startsWith('text/html')
    && req.headers['sec-fetch-dest'] === 'document'
    && !hasPhishCookie(req.headers.cookie)
  ) {
    await sendPhishingNotice(req, res, context.vars);
    return;
  }

  await proxyFile(req, res, { fetchImpl: options.fetchImpl || globalThis.fetch }, context);
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
  if (!headers['X-Content-Type-Options']) {
    headers['X-Content-Type-Options'] = 'nosniff';
  }
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
      rg_site_name: process.env.GITHACK_SITE_NAME || baseDomain(),
      rg_source_url: process.env.GITHACK_SOURCE_URL
        || 'https://github.com/neoascetic/rawgithack',
      ...vars,
      status: String(status),
      title: `Error ${status}`,
      description: `${process.env.GITHACK_SITE_NAME || baseDomain()} - Error ${status}`,
    });
  } catch {
    body = `<!doctype html><title>Error ${status}</title><p>Error ${status}</p>`;
  }

  const headers = { 'Content-Type': 'text/html; charset=utf-8', ...pageSecurityHeaders() };
  applyCacheHeaders(headers, cacheControlFor({ status }), tag);
  send(res, status, headers, body);
}

async function sendPhishingNotice(req, res, vars) {
  const safeVars = {
    ...vars,
    rg_origin: escapeHtml(vars.rg_origin || ''),
    rg_origin_uri: escapeHtml(vars.rg_origin_uri || vars.request_uri || ''),
    rg_site_name: escapeHtml(vars.rg_site_name || ''),
    target_url: escapeHtml(`https://${vars.http_host || ''}${vars.request_uri || '/'}`),
  };

  const body = await render(WEB_ROOT, PHISH_HTML, safeVars);
  send(res, 460, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': CACHE_CONTROL.none,
    Vary: 'Cookie',
    ...pageSecurityHeaders(),
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

  // Prefer the extension-derived type. Fall back to the upstream type for
  // legacy short-link records that predate content-type storage.
  const responseType = contentType || upstreamContentType || 'application/octet-stream';

  const headers = {
    'Content-Type': responseType,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'none',
    'Access-Control-Allow-Origin': '*',
  };

  if (
    /text\/html|image\/svg\+xml|application\/xhtml\+xml|(?:text|application)\/(?:xml|xslt\+xml)/.test(responseType)
  ) {
    headers['Content-Security-Policy'] =
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
  }

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
  if (location) {
    try {
      const resolved = new URL(location, target);

      if (resolved.host === origin) {
        const scheme = isSecureRequest(req) ? 'https' : 'http';
        headers.Location = `${scheme}://${vars.http_host}${resolved.pathname}${resolved.search}${resolved.hash}`;
      } else if (resolved.host === vars.http_host) {
        headers.Location = resolved.href;
      }
      // Cross-host redirects from the upstream are dropped.
    } catch {
      // Invalid upstream Location: omit it.
    }
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

async function sendFavicon(res) {
  try {
    const body = await render(WEB_ROOT, 'internal/icon.svg', {});
    const headers = { 'Content-Type': 'image/svg+xml' };
    applyCacheHeaders(headers, CACHE_CONTROL.immutable, 'rgfavicon');
    send(res, 200, headers, body);
  } catch {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
  }
}

async function sendOpensearch(res, context) {
  try {
    const body = await render(WEB_ROOT, 'internal/opensearch.xml', context.vars);
    send(res, 200, {
      'Content-Type': 'application/opensearchdescription+xml; charset=utf-8',
      'Cache-Control': 'max-age=3600, public',
    }, body);
  } catch {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
  }
}

async function sendLanding(res, context) {
  const body = await render(WEB_ROOT, 'landing.html', {
    ...context.vars,
    rg_show_signin: '1',
  });

  send(res, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...pageSecurityHeaders(),
  }, body);
}

async function sendIndex(req, res, context, { dashboard = false } = {}) {
  const body = await render(WEB_ROOT, dashboard ? 'dashboard.html' : 'index.html', context.vars);
  const headers = { 'Content-Type': 'text/html; charset=utf-8', ...pageSecurityHeaders() };

  if (dashboard) {
    // The dashboard contains the signed-in username and must never be cached
    // by the browser or Vercel's shared CDN.
    headers['Cache-Control'] = 'no-store';
  } else {
    applyCacheHeaders(headers, CACHE_CONTROL.index, context.tag);
  }

  send(res, 200, headers, body);
}

async function handlePurge(req, res, store, user) {
  if (req.method !== 'DELETE') {
    send(res, 405, { Allow: 'DELETE', 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (!enforceRateLimit(
    res,
    `purge:${user?.username || clientIp(req)}`,
    { windowMs: 60 * 1000, max: 60 },
    'too many purge requests',
  )) {
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
  const singleHost = isDeploymentHost(hostname)
    && (!resolved.known || hostname.endsWith('.vercel.app'));

  const shortMatch = parsed.pathname.match(/^\/s\/([A-Za-z0-9_-]{2,64})\/?$/);
  let tag;

  if (shortMatch) {
    const record = store ? await store.getProxy(shortMatch[1]) : null;
    if (!record) {
      send(res, 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify({ error: 'short link not found' }));
      return;
    }

    if (!isAdmin(user) && record.owner !== user?.username) {
      send(res, 403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify({ error: 'not allowed to purge this short link' }));
      return;
    }

    tag = `p${shortMatch[1]}`;
  } else {
    if (!isAdmin(user)) {
      send(res, 403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify({ error: 'admin access required to purge file URLs' }));
      return;
    }

    let filePath = parsed.pathname;
    let prefix = null;

    if (singleHost) {
      const segment = filePath.split('/')[1]?.toLowerCase() ?? '';
      prefix = resolvePathPrefix(segment);
      if (prefix) {
        filePath = filePath.slice(segment.length + 1) || '/';
        if (!filePath.startsWith('/')) filePath = `/${filePath}`;
      }
    }

    if (isDirectoryPath(filePath)) filePath = `${filePath}index.html`;

    const origin = prefix?.origin || resolved.origin || hostname;
    tag = cacheTagFor(origin, filePath);
  }

  try {
    const { invalidateByTag } = await import('@vercel/functions');
    await invalidateByTag(tag);
    logSecurityEvent('cache_purge', { username: user?.username || null, tag });
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
  const hostHeader = req.headers.host || 'localhost';
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  const requestUri = req.url || '/';
  const url = new URL(requestUri, `http://${hostHeader}`);
  const { pathname, search } = url;
  const scheme = req.headers['x-forwarded-proto']
    || (req.socket?.encrypted ? 'https' : 'http');

  const deployment = isDeploymentHost(hostname);
  const hostInfo = resolveHost(hostname);
  const singleHost = deployment
    && (!hostInfo.known || hostname.endsWith('.vercel.app'));
  const base = singleHost ? hostname : baseDomain();
  const canonical = singleHost ? hostname : canonicalHost();
  const siteName = process.env.GITHACK_SITE_NAME || base;
  const sourceUrl = process.env.GITHACK_SOURCE_URL
    || 'https://github.com/neoascetic/rawgithack';

  let resolved = hostInfo;
  let routingPath = pathname;

  if (!hostInfo.known) {
    if (!deployment) {
      send(res, 301, { Location: `https://${canonical}${requestUri}` }, '');
      return;
    }

    // Preview/deployment domains act as the development raw host so the
    // project can be exercised before custom domains are attached.
    resolved = { known: false, origin: 'raw.githubusercontent.com', isCdn: false };
  }

  // A single host (e.g. *.vercel.app) cannot use platform subdomains, so
  // platform and CDN selection move into the first path segment:
  //   /gl/user/repo/raw/branch/file
  //   /cdn/user/repo/tag/file
  if (singleHost) {
    const segment = pathname.split('/')[1]?.toLowerCase() ?? '';
    const prefix = resolvePathPrefix(segment);

    if (prefix) {
      resolved = { known: true, origin: prefix.origin, isCdn: prefix.isCdn };
      routingPath = pathname.slice(segment.length + 1) || '/';
      if (!routingPath.startsWith('/')) routingPath = `/${routingPath}`;
    }
  }

  const context = {
    origin: resolved.origin,
    isCdn: resolved.isCdn,
    pathname: routingPath,
    search,
    tag: cacheTagFor(resolved.origin, routingPath),
    singleHost,
    vars: {
      request_uri: requestUri,
      http_host: hostHeader,
      rg_origin: resolved.origin,
      rg_origin_uri: `${routingPath}${search}`,
      rg_base_domain: base,
      rg_canonical_host: canonical,
      rg_single_host: singleHost ? '1' : '0',
      rg_site_name: siteName,
      rg_source_url: sourceUrl,
    },
  };

  // Collapse duplicate slashes with a redirect.
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

  const hostContext = { base, canonical, singleHost, hostHeader, scheme, siteName, sourceUrl };

  const registrationMatch = pathname.match(/^\/register\/([^/]+)\/?$/);
  if (registrationMatch) {
    try {
      await handleRegister(req, res, options, hostContext, registrationMatch[1]);
    } catch (error) {
      logSecurityEvent('database_error', {
        scope: 'register',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      await sendError(res, 503, siteVars(hostContext), null);
    }
    return;
  }

  if (pathname === '/register' || pathname === '/register/') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      await sendRegisterStartPage(res, hostContext);
      return;
    }

    if (req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const token = (params.get('token') || '').trim();
      if (!token) {
        await sendRegisterStartPage(res, hostContext);
        return;
      }
      send(res, 303, {
        Location: `/register/${encodeURIComponent(token)}`,
        'Cache-Control': 'no-store',
      }, '');
      return;
    }

    send(res, 405, { Allow: 'GET, POST', 'Content-Type': 'text/plain' }, 'Method Not Allowed');
    return;
  }

  if (pathname === '/login' || pathname === '/login/') {
    try {
      await handleLogin(req, res, options, hostContext);
    } catch (error) {
      logSecurityEvent('database_error', {
        scope: 'login',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      await sendLoginPage(res, hostContext, {
        status: 503,
        error: 'Authentication database is unavailable.',
      });
    }
    return;
  }

  if (pathname === '/logout' || pathname === '/logout/') {
    try {
      await handleLogout(req, res, options);
    } catch {
      send(res, 500, { 'Content-Type': 'text/plain' }, 'Logout failed');
    }
    return;
  }

  if (/^\/s\/[A-Za-z0-9_-]{2,64}\/?$/.test(pathname)) {
    try {
      await handleShortProxy(req, res, options, hostContext);
    } catch (error) {
      logSecurityEvent('database_error', {
        scope: 'short_link',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      await sendError(res, 503, siteVars(hostContext), null);
    }
    return;
  }

  if (pathname === '/favicon.svg') {
    await sendFavicon(res);
    return;
  }

  if (pathname === '/favicon.ico') {
    send(res, 301, { Location: '/favicon.svg', 'Cache-Control': 'no-store' }, '');
    return;
  }

  if (pathname === '/opensearch.xml') {
    await sendOpensearch(res, context);
    return;
  }

  const adminPath = pathname === '/admin'
    || pathname === '/admin/'
    || pathname.startsWith('/admin/');
  const dashboardPath = pathname === '/dashboard'
    || pathname.startsWith('/dashboard/');
  const apiPath = pathname.startsWith('/api/');
  const publicFile = !adminPath && !apiPath && !dashboardPath
    && (isFileLikePath(routingPath) || isDirectoryPath(routingPath));
  const anonymousLanding = pathname === '/'
    && (req.method === 'GET' || req.method === 'HEAD');
  const authConfigured = options.store !== undefined
    ? Boolean(options.store)
    : Boolean(process.env.MONGODB_URI);
  let store = null;
  let user = null;

  if (!publicFile) {
    try {
      store = await storeFor(options);
      if (store) {
        user = await currentUser(req, store);

        if (!user && !anonymousLanding) {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const next = encodeURIComponent(requestUri);
            send(res, 302, {
              Location: `/login?next=${next}`,
              'Cache-Control': 'no-store',
            }, '');
          } else {
            send(res, 401, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            }, JSON.stringify({ error: 'authentication required' }));
          }
          return;
        }
      }
    } catch (error) {
      logSecurityEvent('database_error', {
        scope: 'auth',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      if (!anonymousLanding) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          await sendError(res, 503, { rg_origin: resolved.origin }, null);
        } else {
          send(res, 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          }, JSON.stringify({ error: 'database unavailable' }));
        }
        return;
      }
    }

    if (user) {
      context.vars.rg_user = user.username;
      context.vars.rg_role = user.role;
    }
  }

  if (pathname === '/purge' || pathname === '/purge/') {
    await handlePurge(req, res, store, user);
    return;
  }

  if (dashboardPath) {
    if (!user) {
      const next = encodeURIComponent(requestUri);
      send(res, 302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' }, '');
      return;
    }

    if (
      (pathname.startsWith('/dashboard/users') || pathname.startsWith('/dashboard/invites'))
      && !isAdmin(user)
    ) {
      send(res, 302, { Location: '/dashboard/links', 'Cache-Control': 'no-store' }, '');
      return;
    }

    await sendDashboardApp(res, hostContext, user);
    return;
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(user)) {
      send(res, 403, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      }, JSON.stringify({ error: 'admin access required' }));
      return;
    }

    await handleAdminApi(req, res, store, user, pathname, hostContext);
    return;
  }

  if (pathname === '/admin' || pathname === '/admin/') {
    if (!isAdmin(user)) {
      await sendError(res, 403, context.vars, context.tag);
      return;
    }

    send(res, 302, { Location: '/dashboard/users', 'Cache-Control': 'no-store' }, '');
    return;
  }

  const adminUserMatch = pathname.match(/^\/admin\/([^/]+)\/?$/);
  if (adminUserMatch) {
    if (!isAdmin(user)) {
      await sendError(res, 403, context.vars, context.tag);
      return;
    }

    let targetName;
    try {
      targetName = decodeURIComponent(adminUserMatch[1]);
    } catch {
      await sendError(res, 404, context.vars, context.tag);
      return;
    }

    send(res, 301, {
      Location: `/dashboard/users/${encodeURIComponent(targetName)}`,
      'Cache-Control': 'no-store',
    }, '');
    return;
  }

  const profileMatch = pathname.match(/^\/([^/]+)\/?$/);
  const reservedProfileNames = new Set([
    'admin', 'login', 'logout', 'register', 'purge', 'api', 's', 'internal',
    'index.html', 'favicon.ico', 'robots.txt',
  ]);
  if (profileMatch && store && user && !reservedProfileNames.has(profileMatch[1].toLowerCase())) {
    let targetName;
    try {
      targetName = decodeURIComponent(profileMatch[1]);
    } catch {
      await sendError(res, 404, context.vars, context.tag);
      return;
    }

    if (!isUsername(targetName)) {
      await sendError(res, 404, context.vars, context.tag);
      return;
    }

    if (!isAdmin(user) && targetName !== user.username) {
      await sendError(res, 403, context.vars, context.tag);
      return;
    }

    const target = store ? await store.getUser(targetName) : null;
    if (!target) {
      await sendError(res, 404, context.vars, context.tag);
      return;
    }

    if (targetName === user.username) {
      send(res, 302, { Location: '/dashboard', 'Cache-Control': 'no-store' }, '');
      return;
    }

    if (isAdmin(user)) {
      send(res, 302, {
        Location: `/dashboard/users/${encodeURIComponent(targetName)}`,
        'Cache-Control': 'no-store',
      }, '');
      return;
    }

    await sendError(res, 403, context.vars, context.tag);
    return;
  }

  if (pathname === '/api/proxies' || pathname === '/api/proxies/') {
    if (req.method === 'POST') {
      await handleCreateProxy(req, res, store, user, hostContext);
    } else {
      await handleListProxies(req, res, store, user, hostContext);
    }
    return;
  }

  const proxyIdMatch = pathname.match(/^\/api\/proxies\/([A-Za-z0-9_-]{2,64})\/?$/);
  if (proxyIdMatch) {
    if (req.method !== 'DELETE') {
      send(res, 405, { Allow: 'DELETE', 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    await handleDeleteProxy(req, res, store, user, proxyIdMatch[1]);
    return;
  }

  if (pathname.startsWith('/api/')) {
    await sendError(res, 404, context.vars, context.tag);
    return;
  }

  if (routingPath === '/') {
    if (resolved.known && hostname !== canonical) {
      send(res, 301, { Location: `https://${canonical}/${search}` }, '');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 403, { 'Content-Type': 'text/html; charset=utf-8' }, '');
      return;
    }

    if (user) {
      send(res, 302, { Location: '/dashboard', 'Cache-Control': 'no-store' }, '');
      return;
    }

    if (authConfigured) {
      await sendLanding(res, context);
    } else {
      await sendIndex(req, res, context);
    }
    return;
  }

  // Internal template paths are not publicly addressable.
  if (routingPath.startsWith('/internal/')) {
    await sendError(res, 404, context.vars, context.tag);
    return;
  }

  // Directory URLs are rewritten to index.html.
  let filePath = routingPath;
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
      'Set-Cookie': `${PHISH_COOKIE}=1; Path=${publicRepoPathFor(pathname, filePath, singleHost)}; `
        + 'Max-Age=86400; SameSite=Lax; HttpOnly; Secure',
    }, '');
    return;
  }

  const extension = extensionOf(filePath);
  const contentType = contentTypeFor(extension);

  // Unknown extension: redirect to the origin so the browser handles it.
  if (!contentType) {
    const headers = {
      Location: `https://${resolved.origin}${filePath}${search}`,
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

// Port of the routing tables from rawgithack.conf.
//
// Keep this file in sync with rawgithack.conf: it is used by the Vercel
// adapter only, while the nginx configuration stays the canonical self-hosted
// deployment.

import { createHash } from 'node:crypto';

// The default public domain. Override with GITHACK_BASE_DOMAIN to host your
// own instance, e.g. GITHACK_BASE_DOMAIN=example.com.
export const DEFAULT_BASE_DOMAIN = 'githack.com';

const PREFIX_ORIGINS = [
  ['gl', 'gitlab.com'],
  ['bb', 'bitbucket.org'],
  ['raw', 'raw.githubusercontent.com'],
  ['gist', 'gist.githubusercontent.com'],
  ['gt', 'gitea.com'],
  ['cb', 'codeberg.org'],
];

// Path prefixes used when the app runs on a single host (e.g. a *.vercel.app
// deployment) where wildcard subdomains are not available.
const PATH_PREFIXES = [
  ['rawcdn', 'raw.githubusercontent.com', true],
  ['cdn', 'raw.githubusercontent.com', true],
  ['raw', 'raw.githubusercontent.com', false],
  ['gistcdn', 'gist.githubusercontent.com', true],
  ['gist', 'gist.githubusercontent.com', false],
  ['glcdn', 'gitlab.com', true],
  ['gl', 'gitlab.com', false],
  ['bbcdn', 'bitbucket.org', true],
  ['bb', 'bitbucket.org', false],
  ['gtcdn', 'gitea.com', true],
  ['gt', 'gitea.com', false],
  ['cbcdn', 'codeberg.org', true],
  ['cb', 'codeberg.org', false],
];

export function resolvePathPrefix(segment) {
  const match = PATH_PREFIXES.find(([prefix]) => prefix === segment);
  if (!match) return null;
  return { prefix: match[0], origin: match[1], isCdn: match[2] };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function baseDomain() {
  return (process.env.GITHACK_BASE_DOMAIN || DEFAULT_BASE_DOMAIN)
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\./, '');
}

export function canonicalHost() {
  return (process.env.GITHACK_CANONICAL_HOST || `raw.${baseDomain()}`)
    .toLowerCase()
    .replace(/:\d+$/, '');
}

export function resolveHost(hostname) {
  const base = baseDomain();
  const canonical = canonicalHost();

  // The configured canonical host always acts as the development raw host.
  if (hostname === canonical) {
    return { known: true, origin: 'raw.githubusercontent.com', isCdn: false };
  }

  // Apex/www URLs are convenient aliases for the raw host.
  if (hostname === base || hostname === `www.${base}`) {
    return { known: true, origin: 'raw.githubusercontent.com', isCdn: false };
  }

  for (const [prefix, origin] of PREFIX_ORIGINS) {
    const match = hostname.match(
      new RegExp(`^${escapeRegExp(prefix)}(cdn)?\\.${escapeRegExp(base)}$`, 'i'),
    );
    if (match) {
      return { known: true, origin, isCdn: Boolean(match[1]) };
    }
  }

  return { known: false, origin: null, isCdn: false };
}

// Extension -> mime type. Same order as the $rg_content_type map.
export const MIME_TYPES = [
  [/^(?:appcache|manifest)$/, 'text/cache-manifest'],
  [/^atom$/, 'application/atom+xml'],
  [/^bat$/, 'application/x-msdownload'],
  [/^coffee$/, 'text/coffeescript'],
  [/^css$/, 'text/css'],
  [/^csv$/, 'text/csv'],
  [/^eot$/, 'application/vnd.ms-fontobject'],
  [/^geojson$/, 'application/vnd.geo+json'],
  [/^(?:hbs|handlebars)$/, 'text/x-handlebars-template'],
  [/^htc$/, 'text/x-component'],
  [/^html?$/, 'text/html'],
  [/^ics$/, 'text/calendar'],
  [/^jscad$/, 'application/javascript'],
  [/^json$/, 'application/json'],
  [/^jsonld$/, 'application/ld+json'],
  [/^kml$/, 'application/vnd.google-earth.kml+xml'],
  [/^(?:md|markdown)$/, 'text/markdown'],
  [/^m?js$/, 'application/javascript'],
  [/^mhtml$/, 'multipart/related'],
  [/^n3$/, 'text/n3'],
  [/^nt$/, 'application/n-triples'],
  [/^otf$/, 'font/otf'],
  [/^(?:owl|rdf)$/, 'application/rdf+xml'],
  [/^pdf$/, 'application/pdf'],
  [/^rss$/, 'application/rss+xml'],
  [/^shexc?$/, 'text/shex'],
  [/^svg$/, 'image/svg+xml'],
  [/^swf$/, 'application/x-shockwave-flash'],
  [/^stl$/, 'model/stl'],
  [/^tt(?:c|f)$/, 'application/x-font-ttf'],
  [/^ttl$/, 'text/turtle'],
  [/^vcard$/, 'text/vcard'],
  [/^vcf$/, 'text/x-vcard'],
  [/^vtt$/, 'text/vtt'],
  [/^woff$/, 'application/font-woff'],
  [/^woff2$/, 'application/font-woff2'],
  [/^xht(?:ml)?$/, 'application/xhtml+xml'],
  [/^xml$/, 'text/xml'],
  [/^txt$/, 'text/plain'],
  [/^(?:xsl|xsd)$/, 'application/xml'],
  [/^xslt$/, 'application/xslt+xml'],
  [/^ya?ml$/, 'text/yaml'],
  [/^wasm$/, 'application/wasm'],
  [/^(?:d|s)?rpm$/, 'application/x-redhat-package-manager'],
];

// Extensions that must not get a charset suffix. Same as $rg_charset_string.
const NO_CHARSET = new Set([
  'bat', 'eot', 'htc', 'kml', 'nt', 'otf', 'pdf', 'svg', 'swf',
  'ttc', 'ttf', 'woff', 'woff2', 'wasm', 'rpm', 'drpm', 'srpm',
]);

export const CACHE_CONTROL = {
  immutable: 'max-age=31536000, public, immutable',
  htmlCdn: 'max-age=86400, private, stale-while-revalidate=60, stale-if-error=604800',
  htmlDev: 'max-age=60, private, stale-while-revalidate=60, stale-if-error=604800',
  hotRejected: 'max-age=3600, public, stale-while-revalidate=60, stale-if-error=604800',
  hotDelayed: 'max-age=300, public, stale-while-revalidate=60, stale-if-error=604800',
  default: 'max-age=60, public, stale-while-revalidate=60, stale-if-error=604800',
  index: 'max-age=86400, public, stale-while-revalidate=60, stale-if-error=604800',
  none: 'no-store',
};

export function mimeTypeFor(extension) {
  const ext = (extension || '').toLowerCase();
  if (!ext) return null;
  for (const [pattern, type] of MIME_TYPES) {
    if (pattern.test(ext)) return type;
  }
  return null;
}

export function contentTypeFor(extension) {
  const type = mimeTypeFor(extension);
  if (!type) return null;
  const ext = extension.toLowerCase();
  return NO_CHARSET.has(ext) ? type : `${type}; charset=utf-8`;
}

export function extensionOf(pathname) {
  const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

export function isDirectoryPath(pathname) {
  // ^/[^/]+/[^/]+/[^/]+/(?:[^/]+/)*$
  return /^\/[^/]+\/[^/]+\/[^/]+\/(?:[^/]+\/)*$/.test(pathname);
}

export function isFileLikePath(pathname) {
  // ^(?<repo>/[^/]+/[^/]+)/[^/]+/.+?(?:\.(?<extension>[a-zA-Z0-9]+))?$
  return /^\/[^/]+\/[^/]+\/[^/]+\/.+$/.test(pathname);
}

export function cacheControlFor({ status, isCdn, contentType, hotStatus }) {
  if (status === 410) return CACHE_CONTROL.immutable;

  if (status >= 200 && status < 400) {
    if (isCdn) {
      if (!contentType || !contentType.startsWith('text/html')) {
        return CACHE_CONTROL.immutable;
      }
      return CACHE_CONTROL.htmlCdn;
    }

    if (contentType && contentType.startsWith('text/html')) {
      return CACHE_CONTROL.htmlDev;
    }

    if (hotStatus === 'REJECTED') return CACHE_CONTROL.hotRejected;
    if (hotStatus === 'DELAYED') return CACHE_CONTROL.hotDelayed;
  }

  return CACHE_CONTROL.default;
}

// Vercel caches function responses only when the response carries s-maxage
// (or a CDN-Cache-Control header). Browsers should still receive the original
// nginx headers, so CDN caching is expressed in a separate header.
export function cdnCacheControlFor(cacheControl) {
  if (!/\bpublic\b/.test(cacheControl)) return null;

  const maxAge = cacheControl.match(/(?:^|,\s*)max-age=(\d+)/);
  if (!maxAge) return null;

  return cacheControl.replace(
    /(^|,\s*)max-age=(\d+)/,
    `$1max-age=${maxAge[1]}, s-maxage=${maxAge[1]}`,
  );
}

const HOT_WINDOW_MS = 60_000;
const hotFiles = new Map();

// Emulates nginx's limit_req_zone + limit_req_dry_run hot-file detection.
// This state is per function instance; it is a best-effort approximation of
// the shared memory zone used by nginx.
export function hotStatusFor(key, now = Date.now()) {
  let bucket = hotFiles.get(key);
  if (!bucket) {
    bucket = [];
    hotFiles.set(key, bucket);
  }

  while (bucket.length && now - bucket[0] > HOT_WINDOW_MS) bucket.shift();
  bucket.push(now);

  if (bucket.length > 11) return 'REJECTED';
  if (bucket.length > 1) return 'DELAYED';
  return 'NORMAL';
}

export function resetHotFiles() {
  hotFiles.clear();
}

export function cacheTagFor(origin, pathname) {
  const digest = createHash('sha256')
    .update(`${origin}${pathname}`)
    .digest('hex')
    .slice(0, 40);
  return `rg${digest}`;
}

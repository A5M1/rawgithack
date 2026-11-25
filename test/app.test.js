import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import { handle } from '../lib/app.js';
import { resetHotFiles } from '../lib/config.js';

let server;
let port;
let fetchImpl;
let calls;

function upstream({ status = 200, body = 'mock', headers = {} } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/plain', ...headers },
    });
  };
}

function request(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: { Host: 'raw.githack.com', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  server = http.createServer((req, res) => {
    handle(req, res, { fetchImpl: (...args) => fetchImpl(...args) });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  calls = [];
  fetchImpl = upstream();
  resetHotFiles();
});

test('index page is rendered from the SSI templates', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.body, /decade proven way to serve files/);
  assert.match(response.body, /rawgit\.hack/);
  assert.match(response.headers['cache-control'], /max-age=86400, public/);
});

test('404 returns the HTML error page', async () => {
  const response = await request('/not-found');
  assert.equal(response.status, 404);
  assert.match(response.body, /Something is wrong\. That's all we know\./);
});

test('/index.html redirects to /', async () => {
  const response = await request('/index.html');
  assert.equal(response.status, 301);
  assert.equal(response.headers.location, 'http://raw.githack.com/');
});

test('duplicate slashes are collapsed with a redirect', async () => {
  const response = await request('/user//repo///branch/file.js');
  assert.equal(response.status, 301);
  assert.equal(response.headers.location, 'http://raw.githack.com/user/repo/branch/file.js');
});

test('root on a non-canonical host redirects to the canonical host', async () => {
  const response = await request('/?url=abc', { headers: { Host: 'gl.githack.com' } });
  assert.equal(response.status, 301);
  assert.equal(response.headers.location, 'https://raw.githack.com/?url=abc');
});

test('unknown hosts redirect to the canonical host', async () => {
  const response = await request('/user/repo/branch/file.js', {
    headers: { Host: 'example.com' },
  });
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.location,
    'https://raw.githack.com/user/repo/branch/file.js',
  );
});

test('index page rejects non-GET methods', async () => {
  const response = await request('/', { method: 'DELETE' });
  assert.equal(response.status, 403);
});

test('file URL rejects methods other than GET, HEAD and POST', async () => {
  const response = await request('/user/repo/branch/file.js', { method: 'DELETE' });
  assert.equal(response.status, 403);
});

test('POST to a file URL is forbidden', async () => {
  const response = await request('/user/repo/branch/file.js', { method: 'POST' });
  assert.equal(response.status, 403);
});

test('unknown extensions redirect to the origin', async () => {
  const response = await request('/user/repo/branch/file.unknown');
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.location,
    'https://raw.githubusercontent.com/user/repo/branch/file.unknown',
  );
  assert.equal(response.headers['x-robots-tag'], 'none');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['cache-control'], 'max-age=86400, public');
});

test('internal pages are not directly accessible', async () => {
  const response = await request('/internal/error.html');
  assert.equal(response.status, 404);
  assert.match(response.body, /Something is wrong/);
});

test('proxied dev file gets proper Content-Type and short cache', async () => {
  const response = await request('/user/repo/branch/dev.js');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.equal(
    response.headers['cache-control'],
    'max-age=60, public, stale-while-revalidate=60, stale-if-error=604800',
  );
  assert.equal(response.headers['x-robots-tag'], 'none');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.body, 'mock');
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/user/repo/branch/dev.js');
});

test('proxied CDN file is cached permanently', async () => {
  const response = await request('/user/repo/branch/cdn.js', {
    headers: { Host: 'rawcdn.githack.com' },
  });
  assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'max-age=31536000, public, immutable');
  assert.match(response.headers['cdn-cache-control'], /s-maxage=31536000/);
  assert.match(response.headers['vercel-cache-tag'], /^rg[0-9a-f]+$/);
});

test('binary types have no charset', async () => {
  const response = await request('/user/repo/branch/font.woff2');
  assert.equal(response.headers['content-type'], 'application/font-woff2');
});

test('upstream headers are replaced', async () => {
  fetchImpl = upstream({
    headers: {
      'set-cookie': 'a=b',
      'content-security-policy': "default-src 'none'",
      'cache-control': 'no-cache',
    },
  });

  const response = await request('/user/repo/branch/hidden.js');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['content-security-policy'], undefined);
  assert.equal(
    response.headers['cache-control'],
    'max-age=60, public, stale-while-revalidate=60, stale-if-error=604800',
  );
});

test('upstream 404 is replaced with the error page', async () => {
  fetchImpl = upstream({ status: 404, body: 'nope' });
  const response = await request('/user/repo/branch/missing.js');
  assert.equal(response.status, 404);
  assert.match(response.body, /Something is wrong/);
});

test('the upstream receives the origin host', async () => {
  await request('/user/repo/branch/file.js', { headers: { Host: 'gl.githack.com' } });
  assert.equal(calls[0].url, 'https://gitlab.com/user/repo/branch/file.js');
});

test('HTML documents show the phishing notice', async () => {
  const response = await request('/user/repo/branch/index.html', {
    headers: { 'Sec-Fetch-Dest': 'document' },
  });
  assert.equal(response.status, 460);
  assert.match(response.body, /This HTML page is hosted on <a href="https:\/\/raw\.githubusercontent\.com\/user\/repo\/branch\/index\.html"/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.vary, 'Cookie');
});

test('directory URLs are rewritten to index.html', async () => {
  const response = await request('/user/repo/branch/', {
    headers: { 'Sec-Fetch-Dest': 'document' },
  });
  assert.equal(response.status, 460);
  assert.match(response.body, /raw\.githubusercontent\.com\/user\/repo\/branch\/index\.html/);
});

test('phishing notice is skipped when the cookie is set', async () => {
  const response = await request('/user/repo/branch/with-cookie.html', {
    headers: { 'Sec-Fetch-Dest': 'document', Cookie: 'a=b; __Http-phish=1; c=d' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'mock');
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
});

test('phishing POST sets the cookie and redirects back', async () => {
  const response = await request('/user/repo/branch/index.html', {
    method: 'POST',
    headers: { Referer: 'http://raw.githack.com/user/repo/branch/index.html' },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, 'https://raw.githack.com/user/repo/branch/index.html');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(
    response.headers['set-cookie'][0],
    '__Http-phish=1; Path=/user/repo/; Max-Age=86400; SameSite=Lax; HttpOnly; Secure',
  );
});

test('phishing POST with a foreign referer is forbidden', async () => {
  const response = await request('/user/repo/branch/index.html', {
    method: 'POST',
    headers: { Referer: 'http://evil.example.com/user/repo/branch/index.html' },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('hot files get progressively longer Cache-Control', async () => {
  const path = `/user/repo/branch/hot-${Date.now()}.js`;
  const values = [];
  for (let i = 0; i < 12; i += 1) {
    const response = await request(path);
    values.push(response.headers['cache-control']);
  }

  assert.equal(values[0], 'max-age=60, public, stale-while-revalidate=60, stale-if-error=604800');
  assert.equal(values[1], 'max-age=300, public, stale-while-revalidate=60, stale-if-error=604800');
  assert.equal(values[10], 'max-age=300, public, stale-while-revalidate=60, stale-if-error=604800');
  assert.equal(values[11], 'max-age=3600, public, stale-while-revalidate=60, stale-if-error=604800');
});

test('GITHACK_BASE_DOMAIN remaps every platform host', async () => {
  const previousBase = process.env.GITHACK_BASE_DOMAIN;
  const previousCanonical = process.env.GITHACK_CANONICAL_HOST;
  process.env.GITHACK_BASE_DOMAIN = 'example.com';
  delete process.env.GITHACK_CANONICAL_HOST;

  try {
    const index = await request('/', { headers: { Host: 'raw.example.com' } });
    assert.equal(index.status, 200);
    assert.match(index.body, /const BASE_DOMAIN = 'example\.com'/);
    assert.match(index.body, /const CANONICAL_HOST = 'raw\.example\.com'/);
    assert.match(index.body, /hostName\('gl'\)/);

    const dev = await request('/user/repo/branch/file.js', {
      headers: { Host: 'raw.example.com' },
    });
    assert.equal(dev.status, 200);
    assert.equal(
      calls.at(-1).url,
      'https://raw.githubusercontent.com/user/repo/branch/file.js',
    );

    const cdn = await request('/user/repo/branch/file.js', {
      headers: { Host: 'rawcdn.example.com' },
    });
    assert.equal(cdn.headers['cache-control'], 'max-age=31536000, public, immutable');

    await request('/user/repo/branch/file.js', { headers: { Host: 'gl.example.com' } });
    assert.equal(calls.at(-1).url, 'https://gitlab.com/user/repo/branch/file.js');

    const oldHost = await request('/user/repo/branch/file.js', {
      headers: { Host: 'raw.githack.com' },
    });
    assert.equal(oldHost.status, 301);
    assert.equal(
      oldHost.headers.location,
      'https://raw.example.com/user/repo/branch/file.js',
    );
  } finally {
    if (previousBase === undefined) delete process.env.GITHACK_BASE_DOMAIN;
    else process.env.GITHACK_BASE_DOMAIN = previousBase;

    if (previousCanonical === undefined) delete process.env.GITHACK_CANONICAL_HOST;
    else process.env.GITHACK_CANONICAL_HOST = previousCanonical;
  }
});

test('GITHACK_CANONICAL_HOST can move the homepage and raw host', async () => {
  const previousBase = process.env.GITHACK_BASE_DOMAIN;
  const previousCanonical = process.env.GITHACK_CANONICAL_HOST;
  process.env.GITHACK_BASE_DOMAIN = 'example.com';
  process.env.GITHACK_CANONICAL_HOST = 'example.com';

  try {
    const index = await request('/', { headers: { Host: 'example.com' } });
    assert.equal(index.status, 200);
    assert.match(index.body, /const CANONICAL_HOST = 'example\.com'/);

    const file = await request('/user/repo/branch/file.js', {
      headers: { Host: 'example.com' },
    });
    assert.equal(file.status, 200);
    assert.equal(
      calls.at(-1).url,
      'https://raw.githubusercontent.com/user/repo/branch/file.js',
    );
  } finally {
    if (previousBase === undefined) delete process.env.GITHACK_BASE_DOMAIN;
    else process.env.GITHACK_BASE_DOMAIN = previousBase;

    if (previousCanonical === undefined) delete process.env.GITHACK_CANONICAL_HOST;
    else process.env.GITHACK_CANONICAL_HOST = previousCanonical;
  }
});

test('Vercel deployment hosts use the Vercel URL with path prefixes', async () => {
  const host = 'demo-githack.vercel.app';

  const index = await request('/', { headers: { Host: host } });
  assert.equal(index.status, 200);
  assert.match(index.body, /const BASE_DOMAIN = 'demo-githack\.vercel\.app'/);
  assert.match(index.body, /const CANONICAL_HOST = 'demo-githack\.vercel\.app'/);
  assert.match(index.body, /const SINGLE_HOST = '1'/);

  const dev = await request('/user/repo/branch/file.js', { headers: { Host: host } });
  assert.equal(dev.status, 200);
  assert.equal(
    calls.at(-1).url,
    'https://raw.githubusercontent.com/user/repo/branch/file.js',
  );

  const cdn = await request('/cdn/user/repo/tag/file.js', { headers: { Host: host } });
  assert.equal(cdn.status, 200);
  assert.equal(
    calls.at(-1).url,
    'https://raw.githubusercontent.com/user/repo/tag/file.js',
  );
  assert.equal(cdn.headers['cache-control'], 'max-age=31536000, public, immutable');

  await request('/gl/group/proj/raw/branch/file.js', { headers: { Host: host } });
  assert.equal(calls.at(-1).url, 'https://gitlab.com/group/proj/raw/branch/file.js');

  const unknown = await request('/cdn/user/repo/tag/file.unknown', {
    headers: { Host: host },
  });
  assert.equal(unknown.status, 301);
  assert.equal(
    unknown.headers.location,
    'https://raw.githubusercontent.com/user/repo/tag/file.unknown',
  );

  const notice = await request('/cdn/user/repo/tag/index.html', {
    headers: { Host: host, 'Sec-Fetch-Dest': 'document' },
  });
  assert.equal(notice.status, 460);
  assert.match(
    notice.body,
    /value="https:\/\/demo-githack\.vercel\.app\/cdn\/user\/repo\/tag\/index\.html"/,
  );
  assert.match(
    notice.body,
    /href="https:\/\/raw\.githubusercontent\.com\/user\/repo\/tag\/index\.html"/,
  );

  const post = await request('/cdn/user/repo/tag/index.html', {
    method: 'POST',
    headers: {
      Host: host,
      Referer: `https://${host}/cdn/user/repo/tag/index.html`,
    },
  });
  assert.equal(post.status, 303);
  assert.equal(
    post.headers.location,
    `https://${host}/cdn/user/repo/tag/index.html`,
  );
  assert.equal(
    post.headers['set-cookie'][0],
    '__Http-phish=1; Path=/cdn/user/repo/; Max-Age=86400; SameSite=Lax; HttpOnly; Secure',
  );
});

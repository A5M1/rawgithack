import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import { handle } from '../lib/app.js';
import { hashPassword } from '../lib/auth.js';
import { resetHotFiles } from '../lib/config.js';

let server;
let port;
let fetchImpl;
let calls;
let currentStore = null;

class FakeStore {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.proxies = new Map();
    this.invites = new Map();
    this.registrationUsed = false;
  }

  async getUser(username) {
    return this.users.get(username) || null;
  }

  async createUser(username, passwordHash, role = 'user') {
    if (this.users.has(username)) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    this.users.set(username, { username, passwordHash, role, createdAt: new Date() });
  }

  async listUsers() {
    return [...this.users.values()].map(({ passwordHash, ...rest }) => rest);
  }

  async setUserRole(username, role) {
    const user = this.users.get(username);
    if (!user) return false;
    user.role = role;
    return true;
  }

  async deleteUser(username) {
    if (!this.users.delete(username)) return false;
    for (const [hash, session] of this.sessions) {
      if (session.username === username) this.sessions.delete(hash);
    }
    for (const [id, proxy] of this.proxies) {
      if (proxy.owner === username) this.proxies.delete(id);
    }
    return true;
  }

  async createInvite(record) {
    this.invites.set(record._id, record);
    return record;
  }

  async getInvite(id) {
    return this.invites.get(id) || null;
  }

  async listInvites() {
    return [...this.invites.values()];
  }

  async deleteInvite(id) {
    return this.invites.delete(id);
  }

  async reserveInvite(id, username) {
    const invite = this.invites.get(id);
    if (!invite || invite.usedAt) return false;
    invite.usedAt = new Date();
    invite.usedBy = username;
    return true;
  }

  async releaseInvite(id) {
    const invite = this.invites.get(id);
    if (invite) {
      delete invite.usedAt;
      delete invite.usedBy;
    }
  }

  async isRegistrationUsed() {
    return this.registrationUsed;
  }

  async reserveRegistration() {
    if (this.registrationUsed) return false;
    this.registrationUsed = true;
    return true;
  }

  async releaseRegistration() {
    this.registrationUsed = false;
  }

  async createSession(hash, username, expiresAt) {
    this.sessions.set(hash, { username, expiresAt });
  }

  async getSession(hash) {
    return this.sessions.get(hash) || null;
  }

  async deleteSession(hash) {
    this.sessions.delete(hash);
  }

  async createProxy(record) {
    if (this.proxies.has(record._id)) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    this.proxies.set(record._id, record);
    return record;
  }

  async getProxy(id) {
    return this.proxies.get(id) || null;
  }

  async deleteProxy(id, owner) {
    const record = this.proxies.get(id);
    if (!record || record.owner !== owner) return false;
    this.proxies.delete(id);
    return true;
  }

  async listProxies(owner) {
    return [...this.proxies.values()].filter((record) => record.owner === owner);
  }
}

function upstream({ status = 200, body = 'mock', headers = {} } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/plain', ...headers },
    });
  };
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
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
    if (body !== undefined) req.write(body);
    req.end();
  });
}

before(async () => {
  server = http.createServer((req, res) => {
    handle(req, res, {
      fetchImpl: (...args) => fetchImpl(...args),
      store: currentStore,
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  calls = [];
  fetchImpl = upstream();
  currentStore = null;
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

test('Vercel deployment hosts use the Vercel URL with path prefixes', async () => {  const host = 'demo-githack.vercel.app';

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

test('dashboard auth protects pages while short links stay public', async () => {
  const store = new FakeStore();
  store.users.set('alice', {
    username: 'alice',
    passwordHash: await hashPassword('correct horse'),
  });
  currentStore = store;

  try {
    const anonymous = await request('/');
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.location, /^\/login\?next=/);

    const publicFile = await request('/user/repo/branch/file.js');
    assert.equal(publicFile.status, 200);

    const loginPage = await request('/login');
    assert.equal(loginPage.status, 200);
    assert.match(loginPage.body, /Sign in/);

    const badLogin = await request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=alice&password=wrong',
    });
    assert.equal(badLogin.status, 401);

    const login = await request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=alice&password=correct+horse',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    const dashboard = await request('/', { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers['cache-control'], 'no-store');
    assert.match(dashboard.body, /<strong>Dashboard<\/strong>/);
    assert.match(dashboard.body, /Signed in as alice/);

    const created = await request('/api/proxies', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://raw.githack.com/user/repo/branch/file.js' }),
    });
    assert.equal(created.status, 201);
    const first = JSON.parse(created.body);
    assert.equal(first.id.length, 8);
    assert.equal(first.shortUrl, `http://raw.githack.com/s/${first.id}`);

    const short = await request(`/s/${first.id}`);
    assert.equal(short.status, 200);
    assert.equal(
      calls.at(-1).url,
      'https://raw.githubusercontent.com/user/repo/branch/file.js',
    );
    assert.equal(
      short.headers['cache-control'],
      'max-age=60, public, stale-while-revalidate=60, stale-if-error=604800',
    );
    assert.equal(short.headers['vercel-cache-tag'], `p${first.id}`);

    const createdCdn = await request('/api/proxies', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://github.com/user/repo/blob/branch/file.js',
        cdn: true,
      }),
    });
    assert.equal(createdCdn.status, 201);
    const second = JSON.parse(createdCdn.body);

    const shortCdn = await request(`/s/${second.id}`);
    assert.equal(shortCdn.status, 200);
    assert.equal(
      calls.at(-1).url,
      'https://raw.githubusercontent.com/user/repo/branch/file.js',
    );
    assert.equal(
      shortCdn.headers['cache-control'],
      'max-age=31536000, public, immutable',
    );

    const list = await request('/api/proxies', { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body).proxies.length, 2);

    const unauthorizedPurge = await request('/purge?url=https://raw.githack.com/user/repo/branch/file.js', {
      method: 'DELETE',
    });
    assert.equal(unauthorizedPurge.status, 401);

    const deleted = await request(`/api/proxies/${first.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(deleted.status, 200);
    assert.equal(JSON.parse(deleted.body).deleted, true);

    const missing = await request(`/s/${first.id}`);
    assert.equal(missing.status, 404);
  } finally {
    currentStore = null;
  }
});

test('secret registration URL works exactly once', async () => {
  const previous = process.env.REGISTRATION_SECRET;
  process.env.REGISTRATION_SECRET = 'one-time-secret';
  const store = new FakeStore();
  currentStore = store;

  try {
    const wrong = await request('/register/not-the-secret');
    assert.equal(wrong.status, 404);

    const page = await request('/register/one-time-secret');
    assert.equal(page.status, 200);
    assert.match(page.body, /Create account/);
    assert.equal(page.headers['referrer-policy'], 'no-referrer');

    const created = await request('/register/one-time-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=alice&password=longpassword&confirm=longpassword',
    });
    assert.equal(created.status, 303);
    assert.equal(created.headers.location, '/');

    const cookie = created.headers['set-cookie'][0].split(';')[0];
    const dashboard = await request('/', { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.body, /Signed in as alice/);

    const reuse = await request('/register/one-time-secret');
    assert.equal(reuse.status, 404);

    const login = await request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=alice&password=longpassword',
    });
    assert.equal(login.status, 303);
  } finally {
    if (previous === undefined) delete process.env.REGISTRATION_SECRET;
    else process.env.REGISTRATION_SECRET = previous;
    currentStore = null;
  }
});

test('admin invites, admin pages and per-user subdirectories', async () => {
  const store = new FakeStore();
  store.users.set('admin', {
    username: 'admin',
    passwordHash: await hashPassword('admin-password'),
    role: 'admin',
    createdAt: new Date(),
  });
  store.users.set('bob', {
    username: 'bob',
    passwordHash: await hashPassword('bob-password'),
    role: 'user',
    createdAt: new Date(),
  });
  currentStore = store;

  const login = async (username, password) => {
    const response = await request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${username}&password=${password}`,
    });
    return response;
  };

  try {
    const anonymousAdmin = await request('/admin');
    assert.equal(anonymousAdmin.status, 302);
    assert.match(anonymousAdmin.headers.location, /^\/login/);

    const adminLogin = await login('admin', 'admin-password');
    assert.equal(adminLogin.status, 303);
    assert.equal(adminLogin.headers.location, '/admin');
    const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];

    const adminPage = await request('/admin', { headers: { Cookie: adminCookie } });
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.body, /Registration invites/);

    const bobLogin = await login('bob', 'bob-password');
    assert.equal(bobLogin.status, 303);
    assert.equal(bobLogin.headers.location, '/');
    const bobCookie = bobLogin.headers['set-cookie'][0].split(';')[0];

    const bobAdmin = await request('/admin', { headers: { Cookie: bobCookie } });
    assert.equal(bobAdmin.status, 403);

    const bobSpace = await request('/admin/bob', { headers: { Cookie: bobCookie } });
    assert.equal(bobSpace.status, 200);
    assert.match(bobSpace.body, /Your user space/);

    const adminView = await request('/admin/bob', { headers: { Cookie: adminCookie } });
    assert.equal(adminView.status, 200);
    assert.match(adminView.body, /Admin view for this user/);

    const invite = await request('/api/admin/invites', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(invite.status, 201);
    const inviteData = JSON.parse(invite.body);
    const invitePath = new URL(inviteData.url).pathname;

    const registerPage = await request(invitePath);
    assert.equal(registerPage.status, 200);

    const register = await request(invitePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=charlie&password=charlie-password&confirm=charlie-password',
    });
    assert.equal(register.status, 303);

    const reuse = await request(invitePath);
    assert.equal(reuse.status, 404);

    const users = await request('/api/admin/users', { headers: { Cookie: adminCookie } });
    assert.equal(users.status, 200);
    const usernames = JSON.parse(users.body).users.map((user) => user.username);
    assert.deepEqual(usernames.sort(), ['admin', 'bob', 'charlie']);

    const roleChange = await request('/api/admin/users/bob', {
      method: 'PATCH',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(roleChange.status, 200);

    const bobNowAdmin = await request('/admin', { headers: { Cookie: bobCookie } });
    assert.equal(bobNowAdmin.status, 200);

    const deleteCharlie = await request('/api/admin/users/charlie', {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    assert.equal(deleteCharlie.status, 200);
    assert.equal(store.users.has('charlie'), false);

    const selfDelete = await request('/api/admin/users/admin', {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    assert.equal(selfDelete.status, 400);

    const legacyFile = await request('/user/repo/branch/file.js');
    assert.equal(legacyFile.status, 200);
  } finally {
    currentStore = null;
  }
});

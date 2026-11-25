rawgithack (custom fork)
========================

This repository is a **custom fork** of
[neoascetic/rawgithack](https://github.com/neoascetic/rawgithack), the source
code behind [rawgit.hack](https://raw.githack.com).

It is **not** the upstream project, and it is not affiliated with or endorsed
by rawgit.hack, its maintainer, or any of the source-hosting services. The
original project and its licence remain the work of their respective authors.

The core proxy behavior is preserved, but this fork adds:

- A Vercel/Express deployment (the legacy nginx setup has been removed)
- MongoDB-backed users, sessions and one-time registration invites
- A login-protected `/dashboard` SPA
- Public short links (`/s/<id>`, including custom names)
- Admin user and invite management
- Configurable site name, domain and footer source link

See [ARCHITECTURE.md](ARCHITECTURE.md) for the request lifecycle, data model,
route map, and a detailed comparison with the upstream nginx implementation.

Supported Platforms
-------------------

The proxy supports the following source code hosting platforms:

- **[GitHub](https://github.com)** - served via `raw` hosts or `/raw` paths
- **[GitHub Gist](https://gist.github.com)** - served via `gist` hosts or paths
- **[GitLab](https://gitlab.com)** - served via `gl` hosts or paths
- **[Bitbucket](https://bitbucket.org)** - served via `bb` hosts or paths
- **[Gitea](https://gitea.com)** - served via `gt` hosts or paths
- **[Codeberg](https://codeberg.org)** - served via `cb` hosts or paths

Both development and production (CDN) URLs are available for each platform.

Deploying to Vercel
-------------------

This fork runs as a Vercel/Express application. The upstream nginx deployment
has been removed from this repository; the proxy logic lives in this codebase:

- `server.js` — Express entrypoint used by Vercel's Express preset
- `lib/app.js` — request routing, proxying, auth and short-link logic
- `lib/config.js` — host, MIME type and cache-control tables modeled on the
  upstream proxy behavior
- `lib/auth.js` — scrypt password hashing, sessions and short IDs
- `lib/db.js` — MongoDB store for users, sessions and short links
- `lib/ssi.js` — small SSI renderer used for the HTML templates in `web/`
- `vercel.json` — routes every request to the function and bundles `web/`

Deploy with the Vercel CLI:

```sh
npm install
npm run dev         # local server on http://localhost:3000
npx vercel deploy   # preview deployment
npx vercel deploy --prod
```

Or import the repository in the Vercel dashboard. The project uses Vercel's
Express preset (`server.js`), so there is no build step.

### Environment variables

Copy `.env.example` to `.env.local` for local development, or add the same
keys in the Vercel project settings. `.env.local` is gitignored.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | For auth/short links | MongoDB connection string |
| `MONGODB_DB` | No | Database name, default `githack` |
| `REGISTRATION_SECRET` | No | Enables `/register/<secret>` once |
| `GITHACK_BASE_DOMAIN` | No | Your domain for subdomain mode |
| `GITHACK_CANONICAL_HOST` | No | Canonical/homepage host override |
| `GITHACK_SITE_NAME` | No | Brand name shown in titles/FAQ, defaults to the base domain |
| `GITHACK_SOURCE_URL` | No | Footer source-code link, defaults to the upstream repo |
| `GITHACK_WEB_ROOT` | No | Template directory, default `web` |
| `PORT` | Local only | Local server port, default `3000` |

`npm run dev` and `npm start` load `.env.local` automatically when it exists.
On Vercel, use the project's Environment Variables settings instead.

### Using the Vercel URL directly

If `GITHACK_BASE_DOMAIN` is not set, a `*.vercel.app` deployment host is used
as both the base and canonical host automatically. Because wildcard
subdomains are not available on `vercel.app`, platform and CDN selection move
into the first path segment:

| URL | Meaning |
| --- | --- |
| `https://project.vercel.app/user/repo/branch/file` | development raw URL |
| `https://project.vercel.app/cdn/user/repo/tag/file` | production raw URL |
| `https://project.vercel.app/gl/group/repo/raw/branch/file` | GitLab |
| `https://project.vercel.app/gistcdn/user/id/raw/file` | Gist CDN |
| `https://project.vercel.app/bb/...`, `/gt/...`, `/cb/...` | other platforms |

The homepage detects this mode and generates the same path-based URLs. The
same prefixes work on preview deployment URLs.

### Hosting on your own domain

Set one environment variable in the Vercel project:

```sh
GITHACK_BASE_DOMAIN=example.com
```

The instance then uses these hosts:

| Host | Upstream |
| --- | --- |
| `raw.example.com` | `raw.githubusercontent.com` |
| `rawcdn.example.com` | `raw.githubusercontent.com` (permanent cache) |
| `gist.example.com`, `gistcdn.example.com` | `gist.githubusercontent.com` |
| `gl.example.com`, `glcdn.example.com` | `gitlab.com` |
| `bb.example.com`, `bbcdn.example.com` | `bitbucket.org` |
| `gt.example.com`, `gtcdn.example.com` | `gitea.com` |
| `cb.example.com`, `cbcdn.example.com` | `codeberg.org` |

Attach either a wildcard domain (`*.example.com`) or each hostname above to
the Vercel project. A wildcard domain requires the domain's nameservers to
point at Vercel. The apex/`www` host also works as a raw host.

The homepage's URL converter automatically generates URLs for your domain.

Optional environment variables:

- `GITHACK_CANONICAL_HOST` — canonical host for the homepage and redirects
  (default: `raw.<GITHACK_BASE_DOMAIN>`). Set it to `example.com` if you want
  the apex domain to be the main host instead of `raw.example.com`.
- `GITHACK_WEB_ROOT` — path to the templates (default: `web/`)

Preview `*.vercel.app` deployments are served as the development raw host so
they can be tested before domains are attached.

### Dashboard, auth and short links

When `MONGODB_URI` is configured, the homepage becomes a login-protected
dashboard. Proxied file URLs and short links stay public, so they can be
embedded without authentication.

Unauthenticated visitors to `/` now see a short landing page explaining how
this fork differs from the original rawgit.hack, with a **Sign in** link in the
top-right. Signed-in users are redirected to `/dashboard`.

Set these Vercel environment variables:

```sh
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/
MONGODB_DB=githack
```

Never commit the connection string. If it has been exposed, rotate the
database password in MongoDB Atlas. Vercel Functions use dynamic IPs, so the
Atlas network access list normally needs `0.0.0.0/0` (or a restricted proxy).

Create an admin from your machine (there is no public signup):

```sh
MONGODB_URI='mongodb+srv://...' npm run create-user -- admin 'a-long-password' --admin
```

The username `admin` always has admin access. Other users can also be promoted
with the `role: "admin"` field in MongoDB or from the admin page.

Users are stored in `<MONGODB_DB>.users` with scrypt password hashes. Sessions
are server-side documents in `.sessions` with a TTL index and are sent as an
HttpOnly `__githack_session` cookie.

#### Pages and per-user paths

| Path | Purpose |
| --- | --- |
| `/dashboard` | SPA shell; redirects to `/dashboard/links` |
| `/dashboard/links` | Create/list short links |
| `/dashboard/account` | Account and sign-out |
| `/dashboard/users` | Admin: users list |
| `/dashboard/users/<username>` | Admin: user detail |
| `/dashboard/invites` | Admin: registration invites |
| `/admin` | Redirects admins to `/dashboard/users` |
| `/register` | Enter an invite code |
| `/register/<token>` | One-time invite registration form |
| `/s/<id>` | Public short link |
| `/owner/repo/ref/file` | Legacy/public proxied file path |
| `/cdn/owner/repo/ref/file` | Legacy/public production path |

`/<username>` redirects to `/dashboard` for the account owner and to
`/dashboard/users/<username>` for admins. `/admin/<username>` redirects to the
same admin user detail page.

#### Registration

Admins create single-use invite links from `/admin`. Each generated URL looks
like:

```
https://your-host/register/<invite-token>
```

Opening it shows the registration form, creates one account, and consumes the
invite. Users can also paste the invite code at `/register`.

The older `REGISTRATION_SECRET` flow still works: set a secret and open
`/register/<REGISTRATION_SECRET>` once. To allow another legacy registration,
delete the `settings` document with `_id: "registration"` in MongoDB.

Logged-in users create short links from `/dashboard/links`. A short link is
stored in `.proxies` with its owner:

```
https://your-host/s/Ab3dE9xQ
```

Short links are public, proxy the file directly, and use the short id as their
cache tag (`pAb3dE9xQ`). They can be created from GitHub/GitLab/Bitbucket/
Gitea/Codeberg URLs or from generated githack URLs, and can be deleted from the
user's space.

The dashboard also accepts an optional custom name (`2-64` characters:
letters, numbers, dash or underscore), producing links such as
`https://your-host/s/my-file.js`. Custom names are unique.

If `MONGODB_URI` is not set, authentication and short links are disabled and
the public homepage is served without login.

### Vercel-specific behavior

- Responses carry the same browser `Cache-Control` as the upstream
  implementation. Vercel's edge cache is controlled separately with
  `CDN-Cache-Control` and cache tags.
- `DELETE /purge?url=...` invalidates the corresponding cache tag with
  `invalidateByTag()` from `@vercel/functions`.
- Hot-file detection is approximated in memory per function instance, so it
  is not shared across all instances.
- Vercel Functions stream upstream bodies; very large files are still subject
  to the platform's request/response limits.

Run the adapter tests with:

```sh
npm test
```
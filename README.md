# rawgithack (custom fork)

A self-hosted source CDN for GitHub, GitLab, Bitbucket, Gitea, Codeberg and
GitHub Gist. Files are proxied with correct `Content-Type` headers and
development/production cache modes.

This repository is a **custom fork** of
[neoascetic/rawgithack](https://github.com/neoascetic/rawgithack). It is **not**
the upstream project and is not affiliated with or endorsed by rawgit.hack, its
maintainer, or any source-hosting service.

## What this fork adds

- Vercel/Express deployment (the original nginx setup is removed)
- MongoDB-backed users, sessions and invite-only registration
- Login-protected dashboard SPA
- Public short links with optional custom names
- Admin user and invite management
- Recovery codes with forced save/confirmation and account recovery
- Webpack-bundled client JavaScript (no production source maps)
- Configurable domain, header title and footer source link

## Supported platforms

| Platform | Host mode | Single-host prefix |
| --- | --- | --- |
| [GitHub](https://github.com) | `raw` | `/` or `/raw` |
| [GitHub Gist](https://gist.github.com) | `gist` | `/gist` |
| [GitLab](https://gitlab.com) | `gl` | `/gl` |
| [Bitbucket](https://bitbucket.org) | `bb` | `/bb` |
| [Gitea](https://gitea.com) | `gt` | `/gt` |
| [Codeberg](https://codeberg.org) | `cb` | `/cb` |

Each platform has a development URL and a production/CDN URL.

## Quick start

```sh
npm install
npm run build       # webpack client bundles
npm run dev         # http://localhost:3000
```

Deploy to Vercel:

```sh
npx vercel deploy
npx vercel deploy --prod
```

Vercel uses the Express preset (`server.js`) and runs `npm run build`.
Environment changes require a redeploy.

## Environment variables

Copy `.env.example` to `.env.local` for local development, or add the same keys
in Vercel → Project → Environment Variables.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | For auth/short links | MongoDB connection string |
| `MONGODB_DB` | No | Database name, default `githack` |
| `REGISTRATION_SECRET` | No | Enables the legacy single-use secret URL |
| `SHORT_LINK_QUOTA` | No | Max short links per user, default `200` |
| `TRUST_PROXY` | No | Set to `1` behind a trusted reverse proxy |
| `GITHACK_BASE_DOMAIN` | No | Domain for subdomain mode |
| `GITHACK_CANONICAL_HOST` | No | Canonical host override |
| `GITHACK_SITE_NAME` | No | Header title, default `Source CDN` |
| `GITHACK_SOURCE_URL` | No | Footer source-code link |
| `GITHACK_WEB_ROOT` | No | Template directory, default `web` |
| `PORT` | Local only | Local server port, default `3000` |

If the login page says **“Authentication database is unavailable”**, verify the
connection locally:

```sh
MONGODB_URI='mongodb+srv://...' MONGODB_DB=githack npm run check-db
```

Common causes are an outdated password, unencoded special characters, Atlas
network restrictions, a paused cluster, or env changes that were not redeployed.

## URL modes

### Vercel URL / single host

If `GITHACK_BASE_DOMAIN` is unset, the request host is used with path prefixes:

| URL | Meaning |
| --- | --- |
| `/user/repo/branch/file` | development raw URL |
| `/cdn/user/repo/tag/file` | production raw URL |
| `/gl/group/repo/raw/branch/file` | GitLab |
| `/gistcdn/user/id/raw/file` | Gist CDN |
| `/bb/...`, `/gt/...`, `/cb/...` | other platforms |

### Custom domain / subdomains

Set `GITHACK_BASE_DOMAIN=example.com` and attach a wildcard domain
(`*.example.com`) or each hostname:

| Host | Upstream |
| --- | --- |
| `raw.example.com` | GitHub raw |
| `rawcdn.example.com` | GitHub raw, permanent cache |
| `gist.example.com`, `gistcdn.example.com` | GitHub Gist |
| `gl.example.com`, `glcdn.example.com` | GitLab |
| `bb.example.com`, `bbcdn.example.com` | Bitbucket |
| `gt.example.com`, `gtcdn.example.com` | Gitea |
| `cb.example.com`, `cbcdn.example.com` | Codeberg |

`GITHACK_CANONICAL_HOST` can move the main host to the apex domain.

## Dashboard and routes

| Path | Purpose |
| --- | --- |
| `/` | Landing page when signed out; redirects signed-in users to `/dashboard` |
| `/dashboard/links` | Create/list short links |
| `/dashboard/account` | Account, sign-out, recovery-code management |
| `/dashboard/users` | Admin: users |
| `/dashboard/users/<username>` | Admin: user detail |
| `/dashboard/invites` | Admin: registration invites |
| `/register` | Enter an invite code |
| `/register/<token>` | One-time registration |
| `/recover` | Reset a password with a recovery code |
| `/recovery-codes` | Forced save/confirmation of recovery codes |
| `/s/<id>` | Public short link |
| `/owner/repo/ref/file` | Legacy public proxy path |
| `/cdn/owner/repo/ref/file` | Legacy public production path |

`/admin` redirects admins to `/dashboard/users`. `/<username>` redirects the
owner to `/dashboard` and admins to `/dashboard/users/<username>`.

## Accounts and registration

Create an admin (no public signup):

```sh
MONGODB_URI='mongodb+srv://...' npm run create-user -- admin 'a-long-password' --admin
```

Admin access comes only from `role: "admin"` in MongoDB. Usernames are not
privileged.

New usernames are 3–32 characters using letters, numbers and underscore. Names
such as `root`, `administrator`, `system`, `api`, `dashboard` and `admin` are
reserved. Only `admin` can be created with `--admin`.

### Recovery codes

On first sign-in, users are redirected to `/recovery-codes` and must save their
one-time codes. They cannot continue until they confirm saving and enter one of
the codes to verify it.

Codes are stored as hashes, can be used once at `/recover`, and are revoked after
a successful recovery. Users can revoke and regenerate codes anytime from
**Dashboard → Account → Recovery codes**.

### Invites

Admins create single-use invite links from `/dashboard/invites`:

```text
https://your-host/register/<invite-token>
```

The older `REGISTRATION_SECRET` URL still works once. Delete the `settings`
document with `_id: "registration"` to allow another legacy registration.

## Short links

Create links from `/dashboard/links` using GitHub, GitLab, Bitbucket, Gitea,
Codeberg or this instance's public URLs.

```text
https://your-host/s/Ab3dE9xQ
https://your-host/s/my-file
```

- Custom names: 2–64 characters, letters/numbers/dash/underscore, unique.
- If no custom name is supplied, no `/s/` record is created; the legacy public
  URL on this instance is returned instead.
- Short links use the short ID as their cache tag.
- Proxied file URLs and short links remain public; the dashboard requires auth.

## Security

- HTML/SVG/XML proxy responses are sandboxed with CSP.
- App pages deny framing and send `X-Content-Type-Options: nosniff`.
- Passwords use scrypt; sessions and recovery codes are stored hashed.
- HTTPS sessions use the `__Host-` cookie prefix.
- Login, registration, purge, short-link and invite creation are rate-limited.
- Cache purges require short-link ownership or admin access.
- Admin authorization uses the MongoDB role only.
- Security-relevant actions are logged as structured JSON events.

## Vercel behavior

- Browser `Cache-Control` follows the upstream rules.
- Vercel edge caching uses `CDN-Cache-Control` and cache tags.
- `DELETE /purge?url=...` invalidates the matching cache tag.
- Hot-file detection is per function instance and approximate.
- Production bundles are built with Webpack and contain no source maps.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — request lifecycle, data model, routes and
  upstream comparison

## Licensing MSC

`gh.ai` is licensed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en).

`web/internal/icon.svg` is under the same license, © 2026 abndev / ava.

The upstream project remains under its original MIT license. See
[LICENSE](LICENSE).

Additional changes by abndev are authored under the
[ABGSLV2 License](LICENSE-ABGSLV2.md).

### Credits

This repository is a custom fork of
[neoascetic/rawgithack](https://github.com/neoascetic/rawgithack). It is not the
upstream project and is not affiliated with or endorsed by rawgit.hack, its
maintainer, or any source-hosting service. The original project and its license
remain the work of their respective authors.

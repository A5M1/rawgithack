rawgit.hack
============

This is the source  code behind [rawgit.hack](https://raw.githack.com) -
CDN for  your source code  that serves files with  proper `Content-Type`
headers.

Supported Platforms
-------------------

rawgit.hack supports the following source code hosting platforms:

- **[GitHub](https://github.com)** - served via `raw.githack.com` subdomain
- **[GitHub Gist](https://gist.github.com)** - served via `gist.githack.com` subdomain
- **[GitLab](https://gitlab.com)** - served via `gl.githack.com` subdomain
- **[Bitbucket](https://bitbucket.org)** - served via `bb.githack.com` subdomain
- **[Gitea](https://gitea.com)** - served via `gt.githack.com` subdomain
- **[Codeberg](https://codeberg.org)** - served via `cb.githack.com` subdomain

Both development and production (CDN) URLs are available for each platform.

Deploying to Vercel
-------------------

The canonical deployment is the nginx configuration in `rawgithack.conf`
(the `docker/Containerfile` builds it). The repository also contains a Vercel
adapter for running the same service without a server:

- `server.js` — Express entrypoint used by Vercel's Express preset
- `lib/app.js` — request routing, proxying and phishing notice logic
- `lib/config.js` — host, MIME type and cache-control tables ported from
  `rawgithack.conf`
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

### Vercel-specific behaviour

- Responses carry the same browser `Cache-Control` as nginx. Vercel's edge
  cache is controlled separately with `CDN-Cache-Control` and cache tags.
- `DELETE /purge?url=...` invalidates the corresponding cache tag with
  `invalidateByTag()` from `@vercel/functions`.
- Hot-file detection (`limit_req_dry_run` in nginx) is approximated in
  memory per function instance, so it is not shared across all instances.
- Vercel Functions stream upstream bodies; very large files are still subject
  to the platform's request/response limits.

Run the adapter tests with:

```sh
npm test
```
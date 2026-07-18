# Deploying the Docs Site

The docs site is a static Docusaurus 3 build that can be served from any CDN,
static host, or container. Configure the subdomain once; pushes to main rebuild
it automatically.

## Quick start (local preview)

```bash
npm run dev:docs         # live-reload dev server at http://localhost:3000
npm run build:docs       # production build → packages/docs/build/
```

## Option A — Vercel (recommended)

1. Push this repo to GitHub.
2. Create a new Vercel project, set the **Root Directory** to `packages/docs`,
   and keep **"Include source files outside of the Root Directory"** enabled
   (it is by default) — the install/build commands run from the repo root
   because the npm-workspaces lockfile lives there.
3. `packages/docs/vercel.json` supplies the install/build commands and output
   directory; nothing else to configure.
4. In project settings → **Environment Variables**, add:
   ```
   DOCS_URL = https://docs.yourcompany.com
   ```
5. In **Domains**, add `docs.yourcompany.com` and follow the CNAME instructions.

## Option B — Docker + nginx

Build the image:

```bash
docker build -f packages/docs/Dockerfile \
  --build-arg DOCS_URL=https://docs.yourcompany.com \
  -t mail-platform-docs .
```

Run it:

```bash
docker run -p 80:80 mail-platform-docs
```

Add to `docker-compose.yml`:

```yaml
docs:
  build:
    context: .
    dockerfile: packages/docs/Dockerfile
    args:
      DOCS_URL: https://docs.yourcompany.com
  ports:
    - "3001:80"
  restart: unless-stopped
```

Set a CNAME record: `docs.yourcompany.com → <your-server-ip-or-hostname>`.

## Option C — Netlify

1. Connect to GitHub, set publish directory to `packages/docs/build`.
2. Build command: `npm run build:docs` (run from repo root).
3. Set environment variable `DOCS_URL`.
4. Configure the custom domain in Site settings → Domain management.

## Updating the OpenAPI reference

The interactive API spec at `/docs/static/openapi.json` is generated from
`packages/shared/src/openapi.ts`. To regenerate:

```bash
npm run export-openapi
```

This runs automatically as part of `npm run build:docs`.

## Branding

Replace these files to apply your own brand:

| File | Purpose |
|---|---|
| `packages/docs/static/img/logo.svg` | Navbar logo (light mode) |
| `packages/docs/static/img/logo-dark.svg` | Navbar logo (dark mode) |
| `packages/docs/static/img/favicon.svg` | Browser tab icon |
| `packages/docs/src/css/custom.css` | CSS variables (primary colour, fonts) |
| `packages/docs/docusaurus.config.ts` | Site title, tagline, URLs, navbar links |

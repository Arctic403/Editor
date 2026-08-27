# Mobile Workspace Editor

Browser-based workspace editor with local IndexedDB storage and manual GitHub pull/push.

## AI handoff

The editor intentionally has no OpenAI API, Codex host, or AI Worker anymore.

1. **Export AI Workspace** creates a JSON snapshot of the current text workspace. Binary files and secret-like files are omitted.
2. Send that JSON snapshot to ChatGPT when you want code changes.
3. **Import AI Patch** loads the returned patch file and opens a review screen.
4. **Apply All Locally** writes only the reviewed changes into the browser workspace.
5. Use the editor's normal **Push Changes** button when you decide to send those changes to GitHub.

Pending imported patches are stored in a small separate IndexedDB database, so a page refresh does not silently lose the review state.


## Cloudflare Editor deploy + RiftCity Live Test

The Cloudflare deployment now uses a Worker entry point (`worker.js`) plus a strict `.assetsignore`.
The repository root remains intact for GitHub Pages, but Wrangler only uploads the active browser
Editor files instead of trying to upload `node_modules` and old builds. This fixes the 25 MiB
static-asset failure caused by `node_modules/workerd/bin/workerd`.

### Live Test workflow

`▶ Live Test` deploys the **current local browser workspace** for `Arctic403/RiftCityV1` to a
separate Worker named `riftcity-live-test`. It does not create a Git commit and does not call the
Editor's GitHub push path.

On first use, the Live Test broker creates/reuses isolated Cloudflare test storage when the
RiftCity `wrangler.toml` declares those bindings:

- D1: `riftcity-live-test-db`
- R2: `riftcity-live-test-assets`

`schema.sql` is applied to the preview D1 before deployment. Existing RiftCity D1/R2 binding names
are preserved, but they are redirected to the preview resources. Production D1/R2 are not used.

The Live Test dialog asks for a Cloudflare Account ID and an API token. The Account ID may be saved
locally; the API token is stored only in `sessionStorage` for the current browser tab and is sent
only to the Editor Worker for the requested Cloudflare API operation. The Worker does not persist it.

The Cloudflare token needs account-scoped permissions sufficient to:
- write Workers scripts,
- read/write D1 (for preview database discovery/creation + schema),
- read/write R2 (for preview bucket discovery/creation).

The preview URL is `https://riftcity-live-test.<account-subdomain>.workers.dev/`.
`STOP PREVIEW` deletes only the preview Worker; test D1/R2 are retained for later test deployments.


## Browser Local Test

The Editor now has two separate RiftCity test paths:

- **⚡ Local Test** — prepares the current local RiftCity browser workspace on-device and serves the
  `public/` app through an Editor-owned service-worker sandbox. This does not contact GitHub and
  does not create a Cloudflare Worker deployment.
- **☁️ Full Test** — keeps the existing isolated Cloudflare preview Worker for real Worker/D1/R2/auth
  testing.

Local Test is intentionally a **frontend test**. It is ideal for scene transitions, camera framing,
movement, touch controls, the pure-JavaScript Block Editor UI, CSS and static assets. The preview
service worker supplies a fake `developer` login plus minimal read-only bootstrap responses
(`/api/auth/me`, player state, world bootstrap and empty effect/service state) so the normal
RiftCity shell can open directly into the City. The published-block GET deliberately returns a local
fallback response so Block World uses the current workspace's `public/block1.js` instead of
pretending D1 exists. Authoritative mutations, R2-backed approved assets and unmocked backend routes
remain blocked. Use Full Test when the change depends on real server routes, authentication, D1, R2,
crime outcomes or other authoritative behavior.

### Pure-JavaScript preview step

RiftCity Local Test no longer compiles a framework bundle in the browser. The current `public/` tree
is copied directly into the Local Test cache and served as native browser JavaScript/modules. This
removes the old client-framework compatibility build, generated UI bundle, and its
RiftCity-specific browser-bundler download.

This remains a browser frontend sandbox rather than a general Node.js/npm runtime. Safari does not
run arbitrary native npm lifecycle scripts here; RiftCity's pure-JavaScript frontend is served
directly from the current IndexedDB workspace.

The preview lives under `/__riftcity_local__/`. `local-test-sw.js` only intercepts requests belonging
to that preview and passes normal Editor requests through untouched.


## Browser Local Test — private Block Editor support

Local Test now supports the private RiftCity `/dev/block-editor` authoring workspace instead of
falling back to the normal City SPA.

- **PREPARE & OPEN EDITOR** builds the current local RiftCity workspace and opens the private Block
  Editor directly.
- **OPEN BLOCK EDITOR** reopens the current Local Test editor without rebuilding.
- The service worker serves a Local Test version of the server-gated Block Editor page and keeps
  the preview URL under `/__riftcity_local__/`, so its API traffic cannot fall out of the sandbox.
- The fake developer session remains local-only.
- Block Editor draft, publish, revert, version-history and restore-revision endpoints are mocked in
  browser Cache Storage for `downtown-commercial-01`, `alley-commerce-01`, and future block IDs.
- Public block GETs return the browser-local published layout after a Local Test publish; before
  that they intentionally fall back to the current workspace source.
- Rebuilding Local Test clears the mocked block database so stale test layouts cannot override a
  newly edited workspace.
- **SAVE PUBLISHED CONFIG TO WORKSPACE** copies every locally published scene `runtimeConfig` into
  `public/config/scene-runtime.json` in the current RiftCity IndexedDB workspace. This makes tuned
  camera/player/movement/interaction values a source-controlled fallback without touching GitHub;
  the normal **Push Changes** flow remains the only way to send that source file to the repo.
- The source-config save preserves scene entries that were not published in the current Local Test
  session and refuses to overwrite malformed/unsupported config JSON.
- Every non-editor authoritative mutation remains blocked. Real D1/R2/auth/security behavior still
  requires **Full Test**.

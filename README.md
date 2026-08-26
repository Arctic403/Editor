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

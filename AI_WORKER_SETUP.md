# iPhone AI setup — single Worker deployment

This project is now configured so **one Cloudflare Worker named `editor` serves both the editor UI and the AI bridge**.

That means the same URL handles all three of these:

- `/` — the editor
- `/health` — bridge health check
- `/api/ai/run` — AI requests

## Cloudflare setup

1. Deploy the repository root with Wrangler/Cloudflare Workers. The root `wrangler.toml` is the source of truth.
2. Add `OPENAI_API_KEY` as a Worker **secret**.
3. Recommended: add `AI_APP_TOKEN` as another Worker secret using a long random value.
4. The Worker is configured with the name `editor` and `workers_dev = true`, so its workers.dev URL is expected to be `https://editor.<your-workers-subdomain>.workers.dev`.
5. In Editor -> AI -> Settings, use that base URL only. Do not append `/health` or `/api/ai/run`.
6. If `AI_APP_TOKEN` is set on Cloudflare, enter the same value into **Private app token** in the editor.
7. Tap **Test Worker**.

## Why this fixes the previous 404

The old ZIP treated the editor and `cloudflare-ai-worker/` as separate deployments. The AI Worker was named `riftcity-workspace-ai`, while the editor was being tested against an `editor....workers.dev` URL. A request to `/health` could therefore reach the editor/static deployment instead of the AI Worker and return 404.

The root `wrangler.toml` now deploys the AI Worker as the `editor` Worker and binds the repository root as static assets. Worker code runs first, handles `/health` and `/api/ai/run`, and passes all normal requests through to the static editor via the `ASSETS` binding.

## Secrets

Never put the OpenAI API key in `wrangler.toml`, `index.html`, or `codex-panel.js`.

Required:

- `OPENAI_API_KEY`

Recommended:

- `AI_APP_TOKEN`

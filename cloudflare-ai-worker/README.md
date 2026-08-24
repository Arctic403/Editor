# RiftCity Workspace AI - Cloudflare Worker

This replaces the old localhost Codex bridge. It is designed for an iPhone/browser-only editor setup:

Editor -> Cloudflare Worker -> OpenAI Responses API -> structured file edits -> preview/apply in the editor.

## Secrets

Never put your OpenAI API key in `wrangler.toml`, `index.html`, or `codex-panel.js`.

Set these Worker secrets in Cloudflare:

- `OPENAI_API_KEY` - required
- `AI_APP_TOKEN` - recommended; make up a long private value and enter the same value in the editor AI Settings panel

With Wrangler these are:

    npx wrangler secret put OPENAI_API_KEY
    npx wrangler secret put AI_APP_TOKEN

You can also create Worker secrets from the Cloudflare dashboard, which is convenient from iPhone.

## Deploy

The Worker source is `src/index.js`. Deploy this folder as a Cloudflare Worker. After deployment Cloudflare gives you an HTTPS URL such as:

    https://riftcity-workspace-ai.<your-subdomain>.workers.dev

Paste that URL into Editor -> AI -> Settings -> Cloudflare Worker URL.

For tighter CORS, change `EDITOR_ORIGIN` in `wrangler.toml` from `*` to the exact origin hosting the editor, then redeploy.

## Model

The default is `gpt-5.1`. Change `OPENAI_MODEL` in `wrangler.toml` if your API project uses another supported coding model. The editor also has an optional model override field.

## What the Worker can and cannot do

It receives text files selected by the editor, asks the OpenAI Responses API for structured full-file edits, and returns them for preview. It does not have a filesystem or terminal, so it cannot run tests or commands like the full local Codex harness. The editor keeps GitHub pushing separate and explicit.

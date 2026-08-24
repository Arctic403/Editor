# AI integration patch

This build replaces the previous localhost Codex bridge with an iPhone-friendly Cloudflare Worker integration.

Added/updated:
- `codex-panel.js` - Cloudflare Worker AI panel with Smart/Active/Workspace context, selection context, task history, conversation continuity, structured multi-file edits, diff preview, Apply/Reject/Apply All, and undo.
- `cloudflare-ai-worker/` - pure JavaScript Worker that calls the OpenAI Responses API using a Cloudflare secret.
- `AI_WORKER_SETUP.md` - setup notes.
- `CODEX_SETUP.txt` - points old local-bridge users to the new Worker flow.
- `index.html` - updated AI panel cache version.

The OpenAI API key is not stored in browser source. GitHub push remains a separate explicit editor action.

# iPhone AI setup

The editor is already patched to use the Cloudflare Worker in `cloudflare-ai-worker/`.

1. Create/deploy a Cloudflare Worker using the contents of `cloudflare-ai-worker/`.
2. Add `OPENAI_API_KEY` as a Worker secret.
3. Strongly recommended: add `AI_APP_TOKEN` as another Worker secret using a long random value.
4. Copy the deployed `https://...workers.dev` URL.
5. Open the editor, tap **✦ AI** -> **Settings**.
6. Paste the Worker URL. If you created `AI_APP_TOKEN`, paste the same token into **Private app token**.
7. Tap **Test Worker**.

The OpenAI key stays only inside Cloudflare. Do not paste the OpenAI key into the editor.

The AI panel includes Smart/Active/Workspace context modes, active selection context, project review, structured multi-file edits, per-file diff previews, Apply/Reject/Apply All, undo for the last AI apply, task history, conversation continuity, request-size trimming, and GitHub-safe explicit push separation.

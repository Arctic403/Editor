# Codex mode setup

The editor now has two providers:

- **Codex (ChatGPT plan)** — uses the companion `codex-host/` service and Codex's official ChatGPT-managed login. No `OPENAI_API_KEY` is required.
- **OpenAI API Worker** — keeps the previous Cloudflare Worker route as an optional fallback and still requires API billing.

## Why there is a companion host

Cloudflare Workers can serve the editor, but they cannot spawn the Codex CLI or provide a normal writable OS working directory. The `codex-host/` folder is a small Node service designed to run on a normal Linux/Windows/macOS host or dev container while the editor remains on Cloudflare.

## Host setup

```bash
cd codex-host
npm install
EDITOR_BRIDGE_TOKEN="use-a-long-random-private-token" npm start
```

The service listens on port `8788` unless `PORT` is set. Expose it over HTTPS before connecting from the iPhone editor.

Optional environment variables:

- `EDITOR_ORIGIN` — exact editor origin; defaults to `*`.
- `PORT` — HTTP port, default `8788`.
- `CODEX_RATE_LIMIT` — task starts per minute, default `6`.
- `CODEX_RUN_TIMEOUT_MS` — max task runtime, default 10 minutes.
- `CODEX_PATH` — explicit Codex executable path if auto-detection is not suitable.

## Editor setup

1. Open **Workspace AI → Settings**.
2. Choose **Codex (ChatGPT plan)**.
3. Enter the HTTPS URL of the running Codex host.
4. Enter the same `EDITOR_BRIDGE_TOKEN` used on the host.
5. Save and tap **Test Bridge**.
6. Tap **Sign in with ChatGPT**.
7. Open the device-sign-in link shown by the editor and enter the one-time code.
8. Return to the editor and tap **Check account**.

After sign-in, normal Run/Fix/Review actions go to `/api/codex/run` on the Codex host. The host creates a temporary workspace, runs Codex with `workspace-write`, network disabled, and no approvals, then returns changed files to the editor. The existing Preview/Apply/Undo flow remains in control; no file is pushed automatically.

For very large repo-wide edits, select **Whole text workspace** in the Context menu before running the task.

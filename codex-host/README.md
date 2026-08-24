# RiftCity Editor Codex Host

This companion Node service lets the mobile editor use the official Codex CLI/SDK with **ChatGPT-managed Codex authentication** instead of an `OPENAI_API_KEY`.

It cannot run inside a Cloudflare Worker because Codex needs a real Node/OS process and a writable working directory. Run it on a machine/container that can stay online while you use the editor (for example a dev container or Codespace).

## Install

```bash
cd codex-host
npm install
```

## Environment

- `EDITOR_BRIDGE_TOKEN` — recommended private token. Use the same value in the editor's Codex settings.
- `EDITOR_ORIGIN` — optional exact editor origin; defaults to `*`.
- `PORT` — defaults to `8788`.

## Start

```bash
EDITOR_BRIDGE_TOKEN="make-a-long-random-token" npm start
```

Expose the service over **HTTPS**. In the editor choose **Codex (ChatGPT plan)**, enter the HTTPS host URL, save, and tap **Test Bridge**.

Then tap **Sign in with ChatGPT**. The host starts Codex's official device-code flow and the editor displays the verification URL and one-time code. After authorizing, tap **Check account**.

## Security design

- The editor never receives or stores ChatGPT OAuth tokens.
- Codex owns its login state on the host.
- Every task runs in a fresh temporary workspace.
- Codex gets `workspace-write` only inside that temporary workspace.
- Network access and Codex web search are disabled for editor tasks.
- Nothing is automatically pushed to GitHub; changed files are returned to the editor's existing diff/apply/undo flow.
- Only one Codex task runs at a time and the host rate-limits task starts.

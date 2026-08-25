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

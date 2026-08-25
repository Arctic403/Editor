# GitHub Issue AI Patch Bridge

This repository contains a small GitHub-native write bridge for structured AI patches.
It does **not** execute shell commands from issues. An owner-authored issue is parsed as data, validated, applied to the checked-out repository, committed, and pushed by GitHub Actions.

## Why it exists

The normal ChatGPT GitHub connection can read the repository but may not have `contents: write` permission. This bridge uses an owner-authored GitHub issue as the command channel and the repository's Actions `GITHUB_TOKEN` for the actual commit.

## Trigger

Only an issue that meets **both** conditions runs the write job:

1. Issue author is the repository owner.
2. Title starts with `[AI PATCH]`.

Other users can open issues, but their issues cannot pass the workflow job condition.

## Payload v1

Put one JSON object in the issue body, either raw or inside a `json` code fence:

```json
{
  "version": 1,
  "branch": "main",
  "commit_message": "AI: update editor status text",
  "changes": [
    {
      "action": "write",
      "path": "example.txt",
      "content": "hello from the bridge\n"
    },
    {
      "action": "delete",
      "path": "old-example.txt"
    }
  ]
}
```

For exact/large text, a write may use exactly one of:

- `content` — UTF-8 text
- `content_base64` — base64-encoded UTF-8 text
- `content_gzip_base64` — gzip-compressed, then base64-encoded UTF-8 text

## Safety limits

The applier rejects:

- more than 40 file operations
- issue bodies larger than 65,000 characters
- individual decoded files larger than 1.5 MB
- decoded patch content larger than 6 MB total
- binary/NUL-containing files
- absolute paths or `..` path traversal
- symlink traversal
- `.git`, workflow/action files, the bridge applier itself, `node_modules`, `.env`, `.npmrc`, private-key/certificate-style files

The workflow cannot modify its own `.github/workflows/` definition through an issue.

## GitHub Actions permission

The workflow declares:

```yaml
permissions:
  contents: write
  issues: write
```

If GitHub rejects the `git push`, check **Repository → Settings → Actions → General → Workflow permissions** and make sure repository policy allows the `GITHUB_TOKEN` to write. GitHub's repository policy can restrict workflow token permissions.

## Proof test

After this ZIP is committed to `main`, create an owner-authored issue:

**Title**

`[AI PATCH] Bridge proof`

**Body**

```json
{
  "version": 1,
  "branch": "main",
  "commit_message": "AI bridge proof",
  "changes": [
    {
      "action": "write",
      "path": ".ai-bridge-proof.txt",
      "content": "AI bridge is working.\n"
    }
  ]
}
```

The workflow should create `.ai-bridge-proof.txt`, commit it to `main`, comment on the issue, and close the issue.

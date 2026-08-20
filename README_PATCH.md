# Editor patch

Replace the existing `app.js`, `index.html`, and `style.css` with these three files.

Main fixes:
- Corrects the stylesheet filename mismatch (`style.css`).
- Real nested file tree with folders, drag/drop moving, folder deletion, and safe DOM rendering.
- IndexedDB workspace stores full paths and text/binary file types.
- ZIP import preserves nested paths and binary files.
- Single-file download and full workspace ZIP download.
- GitHub updates retrieve the existing file SHA before PUT, so existing files can be updated.
- GitHub paths are URL encoded correctly and API errors are surfaced.
- GitHub repository import preserves text/binary content.
- Unsaved-change protection and auto-save.
- Safer filename handling (no inline onclick strings / raw HTML filenames).
- Mobile-friendly toolbar/tree/editor layout.

Note: GitHub tokens are still stored in browser localStorage by design of the existing app. For a public production app, use a backend or OAuth flow instead of long-lived PATs in localStorage.

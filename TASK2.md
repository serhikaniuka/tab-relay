# Tab Relay: additional requirements (phase 2)

Continue the existing Tab Relay project in this directory. Read TASK.md, SUMMARY.md and the code first, then extend it:

1. **Move between computers**: in the web UI tree, any tab, window or whole profile can be sent to another client (Chrome profile on another machine): open there and close on the source. Support both buttons and drag-and-drop in the tree (drop on a target client/profile node).
2. **Archive**: tabs/windows can be archived: they are closed on the source browser and kept on the server in an "Archive" section of the tree (grouped by source machine → profile → date). From the archive they can be restored (opened on any chosen client) or deleted permanently.
3. **Delete**: tabs/windows can simply be closed and removed (no archive), with a confirmation.
4. **Offline save**: tabs can be saved for offline reading. The extension captures the page with chrome.pageCapture.saveAsMHTML (permission "pageCapture") and uploads it to the server (store files on disk under server/data/offline/, metadata in SQLite; raise body size limits). The UI marks such tabs with an "offline" badge and lets you open the saved copy served by the server (Content-Type multipart/related for .mhtml, plus a download link), even after the original tab was closed or the site is unavailable. Offline save can be combined with archive ("Archive + save offline"). Show stored size; allow deleting offline copies.
5. Bulk actions on checkbox selections for all of the above.

Keep the token auth on every endpoint (offline view links may carry the token as a query param). Update README.md and SUMMARY.md, add tests for the new API endpoints and run them, commit, and restart the server in the tmux session `tab-relay-server` and verify with curl.

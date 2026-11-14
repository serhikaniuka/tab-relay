# Tab Relay: per-row action buttons (phase 6)

User feedback on the tab table:
Next to each row's checkbox (before the URL), add small per-row icon buttons: **Delete**, **Save offline**, and **Archive**.

Requirements:
1. Each button performs the same action as the existing bulk actions, but for that single tab only. Reuse the existing API endpoints; do not invent a new API unless something is missing.
2. Keep the buttons compact (icon or short icon+label), with tooltips (Delete, Save offline, Archive). Styling must be consistent with the phase-5 table: comfortable padding, not cramped, works in both grouped and Flat list modes. The archive table should stay consistent where it makes sense (e.g. no Archive button if already archived; show restore/unarchive if that already exists for bulk).
3. After an action, show status/feedback (success/error) and refresh the row / table. If a tab already has an offline copy, indicate that (and disable or change the Save offline button as appropriate, matching existing bulk behavior).
4. Keep the existing bulk/toolbar actions. Checkboxes and bulk actions must still work.
5. No extension changes should be needed (this is web UI only: server/public). Bump the extension version only if you actually change the extension.
6. Update tests and scripts/e2e.js if relevant. Run all tests and scripts/e2e.js and make sure they pass.
7. If server code changed, restart the server in the existing tmux session `tab-relay-server` (same pattern as previous phases). If only UI/static files changed, a page refresh is enough; still mention that clearly.
8. Commit the work to git with a clear message. Append a short note to SUMMARY.md describing the change, how to use the new buttons, and whether the user only needs to refresh the page or also reload the extension.

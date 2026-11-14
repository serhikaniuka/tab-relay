# Tab Relay: single-line rows and column widths (phase 7)

User feedback on the tab table:
1. **Row height:** every tab row must be exactly one line tall (a single line of text). This applies to both the live table and the archive table, in both grouped and Flat list modes. Keep the checkbox and the per-row action buttons compact and on the same line as the text. Group header rows should stay readable (they may be slightly taller if needed, but should not wrap wildly).
2. **Column widths:** of the remaining width after the checkbox and row-button columns, give **URL 25%**, **Title 25%**, and **Description 50%**. Use `table-layout: fixed` and a `colgroup` (or equivalent) so the ratios hold. The archive table has an extra date/Archived column; keep that compact and apply the 25/25/50 split to URL / Title / Description of the remaining flexible width.
3. **Overflow:** truncate overflowing text in the URL, Title and Description cells with `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`. Show the full text on mouse hover: a native `title` tooltip at minimum; ideally also a styled hover popover with the full text (especially useful when the text is long). Do this for those three columns at least.

Keep existing row buttons, sorting, grouping, flat list, and bulk actions working. No extension changes should be needed (web UI only: server/public). Bump the extension version only if you actually change the extension.

Update tests and scripts/e2e.js if needed (e.g. assert single-line tab row height, and the column width ratios approximately 25/25/50 for URL/Title/Description). Run all tests and scripts/e2e.js and make sure they pass.

If server code changed, restart the server in the existing tmux session `tab-relay-server` (same pattern as previous phases). If only UI/static files changed, a page refresh is enough; still mention that clearly.

Commit the work to git with a clear message. Append a short note to SUMMARY.md describing the change and whether the user only needs to refresh the page or also reload the extension.

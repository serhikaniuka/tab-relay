# Tab Relay: table polish (phase 5)

User feedback on the table view:
1. **Spacing**: add comfortable padding/spacing: cell padding (e.g. 8-10px vertical, 12px horizontal), spacing between columns, row height, indentation of group header rows by level (machine / profile / window) and of tab rows under them, margins around the table and toolbar. Keep it readable, not cramped; keep the archive table consistent.
2. **Sorting**: clickable column headers at the top. At minimum sort by URL (by domain/host then full URL), ascending/descending toggle with an arrow indicator; also allow sorting by Title and Description. Sorting applies within each group (machine → profile → window stays), and add a toolbar option "Flat list (no grouping)" so the user can sort all tabs globally by URL. Remember the sort choice in localStorage. Default: original browser tab order.

No extension changes needed (server/public only). Update e2e/tests if relevant, run them, commit, restart server in tmux tab-relay-server, verify with curl. Append a short note to SUMMARY.md.

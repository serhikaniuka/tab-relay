# Tab Relay: table view with page descriptions (phase 4)

The user wants tabs shown as a TABLE. Columns, in this order:
1. URL (the site URL; clickable; show it shortened if long, full on hover)
2. Title
3. Short description: what the page is about (1–2 sentences, up to ~200 chars)

Keep the grouping context (machine → profile/account → window) as group header rows or a sticky group label in the table, plus checkboxes per row and per group so all existing actions (open/move/archive/archive+offline/save offline/delete, drag&drop onto a target) keep working. The Archive section should also be a table with the same columns (plus archived date). Keep a toggle to switch back to the old tree view if cheap; table is the default.

Description source (no paid AI APIs):
- The extension extracts it from the live page: <meta name=description>, og:description, twitter:description; if none, the first meaningful paragraph text (trimmed). Use chrome.scripting.executeScript (add "scripting" permission + host permissions "<all_urls>"), on tab complete and for existing tabs at startup; skip chrome://, Web Store, etc. Cache per URL; send with state push.
- Server stores descriptions per URL (table page_meta), so archived tabs keep them; if a tab has none (e.g. discarded/unloaded tab), the server may fetch the URL itself (timeout 5 s, size cap, only http/https, rate-limited, LAN-safe: block private IP ranges) and parse the same meta tags. For offline copies, the description can come from the MHTML HTML.
- Show "—" when unknown.

Bump extension version, update tests (add for page_meta + fetch fallback with a local test server), run all tests and the e2e script, commit, restart server in tmux tab-relay-server, verify with curl. Append to SUMMARY.md, noting that the extension needs reloading and will ask for new permissions.

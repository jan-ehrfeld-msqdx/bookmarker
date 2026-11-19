# Bookmarker

Chrome / Vivaldi (Manifest V3) extension that exports your bookmarks and browsing history to JSON files in a folder of your choice and keeps them in sync.

Browser extensions cannot write to arbitrary paths, so the extension talks to a tiny local Node.js program (native messaging host, in [host/](host)) that does the file writing.

## Install
1. Requires [Node.js](https://nodejs.org) on PATH.
2. Open `chrome://extensions` (Vivaldi: `vivaldi://extensions`), enable **Developer mode**, **Load unpacked** → select this folder. The extension ID is fixed (`ecfhfdccjhffhlpjhiefgnpafbkfniia`, via the `key` in `manifest.json`).
3. Register the host (Windows, current user): `powershell -ExecutionPolicy Bypass -File host\install.ps1`. It registers for Chrome, Chromium, Vivaldi and Brave.
4. Restart the browser, open the extension's options page (click the toolbar icon), enter an absolute target folder, **Save**, then **Sync now**.

## Behaviour
- Writes `bookmarks.json` and `history.json` into the chosen folder, replacing them atomically on every sync.
- Syncs on install, browser start, every N minutes (default 15), and ~30 s after any bookmark change.
- `bookmarks.json`: full bookmark tree snapshot.
- `history.json`: accumulated visits (browsers only keep ~90 days; the extension keeps the full set in its own storage).
- `tabs.json`: snapshot of all open tabs per window (URL, title, pinned, active, Chrome tab group). In Vivaldi each tab also carries its `workspace` (name) and `workspaceId`, plus the raw `vivExtData` (which also holds Vivaldi tab-stack info). Workspace names are read by the host from Vivaldi's `Default` profile `Preferences` file. In Chrome, `workspace` is `null` and `tabGroups` lists the native tab groups. Updated ~30 s after tab changes.

## Restore
Options page → **Restore**: pick a file written by the extension (from the target folder or its `backups` subfolder).
- **Bookmarks:** imported into a new `Restored <date>` folder inside Other bookmarks; existing bookmarks are untouched.
- **History:** merged into the extension's accumulated history (browsers can't add visits with their original dates), so the next sync writes it back to `history.json`. Do this after reinstalling the extension, otherwise the next sync would write a history.json containing only the browser's recent history.
- **Tabs:** reopened in new windows with pinned state and tab groups (Chrome/Brave). For a Vivaldi file you can restore just one workspace; tabs open as plain tabs because workspaces can't be assigned via the extension API.
- The host keeps a copy of the previous file once a day (last 14) in `<target folder>\backups`, because every sync overwrites the files (e.g. a fresh empty profile would otherwise replace your last good export).

## Notes
Using the extension in several browsers (e.g. Vivaldi and Brave): load it in each (`brave://extensions`) and give each browser its **own target folder** in the options, otherwise they overwrite each other's files.
Moving the repo folder requires re-running `host\install.ps1`. Removing the extension loses the accumulated history store (the JSON file stays).

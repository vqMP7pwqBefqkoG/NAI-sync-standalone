# NAI Sync Standalone (NovelAI Local Panel)

NAI Sync Standalone is a Tampermonkey userscript that adds local history, restore, tag suggestions, and mobile editing helpers to NovelAI. It runs without the N-Sync server by storing data in the browser's IndexedDB and by loading tag data from this repository.

## Active Files

- `NovelAI_Local.user.js`: Tampermonkey userscript
- `danbooru_tags.json` / `danbooru_tags.json.gz`: Danbooru tag data
- `e621_tags.json` / `e621_tags.json.gz`: e621 tag data

`old_novelai.js` and `temp_old.js` are untracked local backup/work files and are not required for normal use.

## Features

- Saves NovelAI generation history in browser IndexedDB
- Stores compressed thumbnails and PNG metadata for restoration
- Groups history by browser session
- Shows session folders and per-session image grids
- Supports a resizable history panel on mobile and desktop
- Restores NovelAI settings from saved image metadata
- Adds and removes favorites
- Shows the current-session generated image grid
- Provides batch/continuous generation helper
- Provides bulk replace across main, negative, and character prompts
- Provides Danbooru/e621 tag autocomplete
- Shows top image thumbnails from Danbooru/e621 when tapping a tag count
- Prioritizes frequently selected tags
- Provides a mobile D-pad for prompt weight adjustment
- Provides local backup, preview, and deletion tools

## Difference From The Server Version

This standalone version does not require a local server.

- History storage: browser IndexedDB
- Tag suggestions: JSON files loaded from GitHub and searched in the browser
- Tampermonkey updates: GitHub raw URL for `NovelAI_Local.user.js`

The server version is developed separately at:

```text
C:\Users\naoki\ai-sync-hub
```

## Requirements

- Tampermonkey
- A browser logged into NovelAI
- Network access for the first tag-data download

The script is designed for mobile-only use, but it also works in desktop browsers.

## Installation

Install the userscript from this raw URL:

```text
https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/NovelAI_Local.user.js
```

The script runs on:

```text
https://novelai.net/*
```

## Basic Usage

1. Open NovelAI's image generation page.
2. Tap the history tab on the right side of the screen.
3. Generate images as usual. Completed generations are saved locally.
4. Open a session folder and tap an image to restore the settings used for that image.
5. Use favorites, search, bulk replace, tag autocomplete, or batch generation as needed.

## Tag Suggestions

While editing a prompt, type part of a tag to show suggestions from Danbooru or e621.

- Tap a tag name to insert it.
- Use the Danbooru/e621 toggle to switch sources.
- Tap the post-count area to show top image thumbnails in a horizontal scroller.
- Frequently selected tags are prioritized.

Tag data is downloaded from GitHub on first use and cached in the browser.

## Prompt Weight D-pad

The D-pad appears around the current tag or selected prompt range.

- Up/down: adjust weight by 0.1
- +0.5 / -0.5: adjust weight by 0.5
- +1.0 / -1.0: adjust weight by 1.0
- Left/right: expand the selected range by comma-separated tag blocks

On mobile, D-pad placement is delayed and refreshed while the keyboard appears, reducing first-tap positioning glitches.

## Data Management

The data management panel can:

- Download a backup
- Preview a backup
- Delete local history and favorites

Browser site-data deletion can remove IndexedDB history. Create a backup before clearing cookies or site data.

## Development Notes

- Edit `NovelAI_Local.user.js` as UTF-8.
- Avoid PowerShell 5.1 `Get-Content` / `Set-Content` for Japanese-containing scripts because it can corrupt comments and string literals.
- Prefer a UTF-8-aware editor, or Node `fs.readFileSync(path, 'utf8')` and `fs.writeFileSync(path, text, 'utf8')`.
- After editing the userscript, run:

```powershell
node --check NovelAI_Local.user.js
```

- Bump `@version` in `NovelAI_Local.user.js` whenever Tampermonkey should detect an update.
- Push changes to GitHub because this standalone version updates through GitHub.

## Tag Data Attribution

Tag suggestion data is derived from public sources:

- Danbooru: https://danbooru.donmai.us/ and https://huggingface.co/datasets/deepghs/site_tags
- e621: https://e621.net/db_export/

Tag names, post counts, and related metadata remain subject to the source platforms' terms and licenses.

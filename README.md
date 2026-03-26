# MV Divest

A Chrome extension for backing up and removing your content from ManyVids before closing your account.

## What it does

MV Divest walks you through five steps:

1. **Fetch Catalogue** — scrapes your ManyVids Content Manager and pulls every video title, price, views, purchases, and edit-page URL
2. **Review** — enriches each entry with its description, keywords, published date, and download link; lets you deselect any videos you don't want to download
3. **Download** — saves all selected videos to a folder you choose, with a progress tracker and per-file status; exports a CSV of your full catalogue metadata
4. **Delete** — removes each downloaded video from your ManyVids catalogue one by one (or all at once)
5. **Close Account** — generates a pre-filled email to ManyVids support requesting account deletion, and lets you share the news on X or download an Instagram story graphic

---

## Installation

MV Divest is a local Chrome extension — it is not published to the Chrome Web Store. You load it directly from the source folder.

### Prerequisites

- Google Chrome (or any Chromium-based browser that supports Manifest V3 extensions)
- Your ManyVids account open and logged in in another tab

### Steps

1. **Download or clone this repository**

   ```bash
   git clone https://github.com/YOUR_USERNAME/mvdl.git
   ```

   Or download the ZIP from GitHub and unzip it anywhere on your computer.

2. **Open Chrome Extensions**

   Go to `chrome://extensions` in your address bar.

3. **Enable Developer Mode**

   Toggle **Developer mode** on (top-right corner of the Extensions page).

4. **Load the extension**

   Click **Load unpacked** and select the folder containing `manifest.json` (the root of this repo).

5. **Pin it (optional)**

   Click the puzzle-piece icon in the Chrome toolbar and pin **MV Divest** for easy access.

6. **Open the dashboard**

   Click the MV Divest icon in your toolbar. The dashboard opens in a new tab.

---

## Usage

Make sure you are logged in to ManyVids in another Chrome tab before starting. The extension will verify your login status on the first screen.

Work through each phase in order using the numbered dots at the top of the page. You can navigate back to any previous phase at any time — if you try to jump to the Delete or Close Account phase without having verified downloads, the extension will warn you first.

### Tips

- **Fetch Details** visits each video's edit page in a background tab. For large catalogues this takes a few minutes. You can stop and resume at any time.
- **Folder scanning** — when you select a download folder, the extension checks for files that already exist and marks them so you don't re-download unnecessarily.
- **CSV export** — saved automatically to your chosen folder when all downloads finish, or export manually at any time from the Downloads phase.
- **Re-download** — individual re-download buttons let you overwrite a specific file if needed.

---

## File overview

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — scraping, downloading, deleting |
| `dashboard.html` | Main UI shell |
| `dashboard.js` | UI logic and state management |
| `dashboard.css` | Styles |
| `icons/` | Extension icons (16px, 48px, 128px) |

---

## Permissions

| Permission | Why |
|-----------|-----|
| `tabs` | Open background tabs to scrape ManyVids pages |
| `scripting` | Inject scraping scripts into those tabs |
| `downloads` | Not used for direct downloads (File System Access API is used instead) |
| `storage` | Cache the video catalogue between sessions |
| `host_permissions: manyvids.com` | Access the Content Manager and edit pages |
| `host_permissions: *` | Follow CDN download URLs to fetch video files |

---

## Privacy

All data stays on your machine. Nothing is sent to any external server. The extension only communicates with ManyVids.com using your existing browser session.

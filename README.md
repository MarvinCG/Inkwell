# Inkwell Notes

A Samsung Notes–style app for the web: typed notes and handwriting on the same page, folders, favorites, trash, search, and sync between your devices. It installs like a native app (a PWA) on:

| Device | Install from | Pen |
|---|---|---|
| Galaxy S26 Ultra | Chrome or Samsung Internet | S Pen: pressure, palm rejection, side button = eraser |
| iPad (A16) | Safari → Share → Add to Home Screen | Apple Pencil (USB-C / 1st gen): pressure, palm rejection |
| ThinkPad – Windows 11 | Edge or Chrome → Install | mouse, touchpad, touchscreen |
| ThinkPad – Ubuntu 26 | Chrome, Chromium or Edge → Install | mouse, touchpad, touchscreen |

**App:** https://marvincg.github.io/Inkwell/ — served by GitHub Pages from this repository.
**Sync:** your private repository [`MarvinCG/inkwell-data`](https://github.com/MarvinCG/inkwell-data). Every device keeps a full offline copy; changes travel through that repo.

```
web/vendor html2canvas 1.4.1 (MIT) — renders the page for PDF export
web/       the app (HTML/CSS/JS, no build step, no dependencies) — what GitHub Pages publishes
server/    optional self-hosted sync server (Node, zero dependencies) — not needed with GitHub sync
.github/   Pages deploy workflow
```

---

## 1. Turn on the app (once)

1. **MarvinCG/Inkwell → Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Actions → “Deploy app to GitHub Pages” → Run workflow** (the run triggered by the first push fails until step 1 is done).
3. After about a minute the app is live at **https://marvincg.github.io/Inkwell/**. Every later push to `main` that touches `web/` redeploys it.

## 2. Create the sync token (once)

Create a **fine-grained personal access token**: https://github.com/settings/personal-access-tokens/new

- **Name:** Inkwell · **Expiration:** your choice (when it expires, paste a new one in Settings on each device)
- **Repository access:** *Only select repositories* → `MarvinCG/inkwell-data`
- **Permissions → Repository permissions → Contents: Read and write** (Metadata: read is added automatically)

Copy the token (`github_pat_…`) into your password manager. That token can only touch `inkwell-data`.

## 3. Install on each device

Open https://marvincg.github.io/Inkwell/, then:

- **S26 Ultra** — Chrome: ⋮ → *Add to home screen* → *Install*. (Samsung Internet: ☰ → *Add page to* → *Home screen*.)
- **iPad** — Safari: Share → *Add to Home Screen*, and always open Inkwell from that icon (Safari may clear data of websites you don't visit for a while, but not of home-screen apps).
- **Windows 11** — Edge/Chrome: the *Install* icon at the right of the address bar → it lands in the Start menu.
- **Ubuntu 26** — Chrome/Chromium/Edge: ⋮ → *Cast, save and share* → *Install page as app*. (Firefox on Linux can't install web apps; it still works in a tab.)

Then in the app: **Settings → Sync → GitHub repo** → repository `MarvinCG/inkwell-data` (already filled in) → paste the token → **Test connection** → **Save**. The cloud icon turns green when synced.

Notes you wrote before setting up sync are uploaded on the first sync.

## Using it

- **+** makes a note. **T / pen** at the top switches between typing and handwriting.
- **Typing**: bold/italic/underline/strike, H1/H2, checklists (tap the box), bullets, numbers, text color, highlight, alignment, photos, voice recordings, dividers. On iPad, Apple Pencil *Scribble* turns handwriting into typed text while in typing mode.
- **Handwriting**: pen (pressure-sensitive), pencil, highlighter, eraser (removes whole strokes), lasso (select → drag to move, duplicate, recolor, delete). 12 colors + custom, size slider, undo/redo.
- **Touch while writing** (button at the end of the pen toolbar, or Settings → Pen & touch):
  - *Pen only* — only an S Pen or Apple Pencil draws; fingers scroll and pinch-zoom; your palm is ignored.
  - *Hand rest* — a simple (non-smart) capacitive stylus or a fingertip draws while you rest your hand; large contacts (a palm) are ignored, including a palm that spreads out as it settles or the side of the hand sitting still.
  - *Fingers* — every touch draws, even a flat finger.
  - *Auto* (default) uses Hand rest until an S Pen or Apple Pencil touches the page, then Pen only. Two fingers together always scroll and zoom. With S Pen, hold the side button while writing to erase.
- **Full screen** (⤢ in a note, or Settings → Full screen): hides the note's top bar and Android's status and navigation bars, the page fills the display, and all tools sit in one slim row (tap ⌃ to tuck them away). On phones it turns on automatically when you start handwriting; *Always* keeps the whole app full screen. The back gesture leaves full screen.
- **Zoom**: −/100%/+ buttons, pinch (pen-only mode), Ctrl + mouse wheel / touchpad pinch on the laptop.
- **Page style** (⋮ menu): blank, lined, grid or dotted; white, cream, mint or sky paper; narrow (phone) or wide (tablet/laptop) page. A note keeps its page width on every device, so handwriting stays exactly where you wrote it next to the text — a note made on the laptop opens zoomed out on the phone, like Samsung Notes.
- **Organize**: folders with colors, favorites (★), sort by modified/created/title, grid or list view, search across titles and text. Long-press (or right-click) a note for quick actions.
- **Trash**: notes stay 30 days, restorable, then are deleted for good.
- **Export**: ⋮ → *Export PDF* builds an A4 PDF in the app (text, photos, checklists and handwriting; pages break between lines) and opens the share sheet — *Save to Files*, *Print*, AirDrop, Mail — or downloads it on the laptop. ⋮ → *Print* (laptop/Android), *Share as text*, and **Settings → Export backup** (one JSON file; *Import backup* merges it back).
- **Keyboard** (laptop): `N` new note, `/` search, `Esc` back, `Ctrl+Alt+D` typing ↔ handwriting, `Ctrl+Z / Ctrl+Y` undo/redo handwriting, `Delete` removes a lasso selection.
- **Dark mode** follows the system (or set it in Settings). Black ink shows as white on dark paper.

## How GitHub sync works

- Layout of `inkwell-data`: `items/<id>.json` (one file per note or folder) and `media/<hash>.txt` (photos and voice notes, stored once even if several notes use them).
- Each sync is at most **one commit**, e.g. “Inkwell: 3 changes from Android”. The repo history doubles as version history: any old version of a note can be found on GitHub.
- When: about 15 s after you stop editing, when you leave the app, every minute while it's open, and when the network comes back. Offline? Keep working — it catches up later.
- Two devices syncing at the same moment can't overwrite each other: pushes are fast-forward only, and the second device re-reads and retries.
- The same note edited on two devices between syncs → you get both, one named “… (conflict copy)”. Deleted on one device but edited on another → the edit wins.

**Privacy:** keep `inkwell-data` private (Settings → Test connection warns if it isn't). The token is stored in the app's storage on each device. All GitHub Pages sites under `marvincg.github.io` share one browser origin, so only publish your own pages there; you can revoke the token on GitHub any time and paste a new one.

## Optional: self-host instead of GitHub (desk)

`server/` is a zero-dependency Node sync server that also serves the app. Run it with Docker Compose behind Tailscale Serve:

```bash
cp .env.example .env && sed -i "s/^SYNC_TOKEN=.*/SYNC_TOKEN=$(openssl rand -hex 24)/" .env
mkdir -p data && docker compose up -d --build        # listens on 127.0.0.1:8095
sudo tailscale serve --bg --https=8443 8095          # https://desk.<tailnet>.ts.net:8443/
```

Then choose **Settings → Sync → Own server** and paste the `SYNC_TOKEN`. Back up `data/`.

| `.env` variable | Default | Meaning |
|---|---|---|
| `SYNC_TOKEN` | — (required, ≥16 chars) | Shared secret the apps send as `Authorization: Bearer …` |
| `MAX_BODY_MB` | `50` | Largest single sync request |
| `CORS_ORIGIN` | empty | Set to `https://marvincg.github.io` to sync the Pages app with this server |
| `TRUST_PROXY` | `0` | `1` = take the client IP for the login rate limit from `X-Forwarded-For` |

## Updating

Push changes to `main` (bump `VERSION` in `web/sw.js` so installed apps pick them up). Open apps show “Inkwell was updated — Reload”.

## Limits

- PDFs are images of the pages (sharp, but the text isn't selectable); voice notes appear as a label.
- Handwriting isn't converted to searchable text (iPad Scribble works only while typing). No shape recognition or PDF annotation yet.
- Photos are compressed to 1600 px JPEG; voice notes are capped at 15 minutes. Media of deleted notes stays in `inkwell-data`'s history.
- Voice notes recorded on Android are WebM/Opus when Chrome can't record MP4; older iPadOS versions may not play those.
- It's an installed web app, not a Play Store / App Store app: updates come from this repository.
- Outside full screen, Chrome paints Android's navigation bar with the color fixed in the manifest when the app was installed; a web app can't recolor it while running. Full screen hides it.

## Docs
- Fine-grained personal access tokens: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Publishing Pages with GitHub Actions: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- Tailscale Serve (self-host option): https://tailscale.com/kb/1242/tailscale-serve

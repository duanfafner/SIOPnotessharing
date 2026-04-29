# SIOP 2026 Conference Notes Hub

A collaborative, community-driven notes platform for the SIOP 2026 Annual Conference in New Orleans. Attendees can contribute session notes in real time, and anyone can browse, filter, and download compiled summaries by track, day, or presenter.

---

## Features

- **Contribute notes** — search sessions by name, ID, or presenter, type free-form notes, and optionally attach a PDF, image, or Word DOCX file
- **AI moderation** — every submission is reviewed by Claude Sonnet before saving to ensure professional, on-topic content
- **Browse & filter** — filter by day, track, or keyword; toggle "has notes only" to find the most active sessions
- **Download summaries** — download a compiled PDF summary of approved notes for any session, including embedded image attachments
- **Auto large-session package** — when a session is very large, downloads automatically switch to a ZIP package for faster delivery
- **Real-time** — notes appear instantly after submission, powered by Supabase

---

## Tech Stack

| Layer | Tool |
|---|---|
| Frontend | Vanilla HTML, CSS, JS (no framework, no build step) |
| Database | Supabase (Postgres) |
| File storage | Supabase Storage |
| Moderation | Anthropic Claude Sonnet API |
| PDF generation | `pdf-lib` via Vercel API route |
| Document extraction | `pdf-parse` (PDF), `mammoth` (DOCX) |
| Packaging | `jszip` for large-session ZIP downloads |
| Hosting | Vercel |
| Version control | GitHub |

---

## Project Structure

```
siop-notes-hub/
├── index.html          # Main HTML — structure and layout
├── styles.css          # All styles, light + dark mode
├── app.js              # All JavaScript logic
├── config.js           # Auto-generated at build time (do not edit)
├── inject-config.js    # Build script — injects env vars into config.js
├── vercel.json         # Vercel build configuration
├── package.json        # npm config (minimal, just for build script)
├── .env.example        # Template for local environment variables
├── .gitignore          # Ignores .env.local, node_modules, etc.
└── README.md           # This file
```

---

## Local Development (Cursor)

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/siop-notes-hub.git
cd siop-notes-hub
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your values:

```env
SUPABASE_URL=https://dmvogtovtvwnakrqqfwc.supabase.co
SUPABASE_KEY=sb_publishable_TgoHH_kM8jPaqekxwoWGgw_vYWW94PX
ANTHROPIC_KEY=your_anthropic_api_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
ANTHROPIC_MODEL_MODERATION=claude-sonnet-4-20250514
ANTHROPIC_MODEL_OCR=claude-sonnet-4-20250514
```

### 3. Generate config and run locally

```bash
npm install
node inject-config.js    # generates config.js from your .env.local
npx serve .              # serves the app at http://localhost:3000
```

To test moderation locally through the `api/moderate` endpoint, run:

```bash
npm run dev:vercel
```

`npx serve .` is still fine for UI-only checks, but moderation is server-side and needs Vercel Functions (or equivalent local API runtime).

> **Tip in Cursor:** Open the terminal (`Ctrl+\``) and run the above commands. The app is a static site — no build framework needed.

---

## Deploying to Vercel (via GitHub)

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit — SIOP 2026 Notes Hub"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/siop-notes-hub.git
git push -u origin main
```

### Step 2 — Connect to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo (`siop-notes-hub`)
3. Vercel will auto-detect the config from `vercel.json`

### Step 3 — Add environment variables in Vercel

In your Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://dmvogtovtvwnakrqqfwc.supabase.co` |
| `SUPABASE_KEY` | `sb_publishable_TgoHH_kM8jPaqekxwoWGgw_vYWW94PX` |
| `ANTHROPIC_KEY` | `your_anthropic_api_key` |
| `SUPABASE_SERVICE_ROLE_KEY` | `your_service_role_key` |
| `ANTHROPIC_MODEL_MODERATION` | `claude-sonnet-4-20250514` |
| `ANTHROPIC_MODEL_OCR` | `claude-sonnet-4-20250514` |
| `DOWNLOAD_ZIP_THRESHOLD` | `80` |
| `SITE_PASSWORD` | `shared SIOP access password` |

### Step 4 — Deploy

Click **Deploy**. Vercel runs `node inject-config.js`, which writes your keys into `config.js`, and your site goes live.

**Every future push to `main` auto-deploys.** No manual steps needed.

---

## Making Changes

The workflow in Cursor:

```
Edit code in Cursor
  → git add .
  → git commit -m "describe your change"
  → git push
  → Vercel auto-deploys in ~30 seconds
```

### Common changes

**Update session data** — re-run the SQL import or update rows directly in Supabase Table Editor.

**Change moderation strictness** — edit the prompt in `app.js` inside the `moderateContent()` function.

**Add a new filter** — add a `<select>` in `index.html` and update the `renderBrowse()` function in `app.js`.

**Update styles** — all styles are in `styles.css`. The app supports light and dark mode via `@media (prefers-color-scheme: dark)`.

---

## Supabase Setup Reference

If setting up from scratch, run this SQL in Supabase → SQL Editor:

```sql
-- Sessions table (populated from conference schedule)
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  track         TEXT,
  day           TEXT,
  time_slot     TEXT,
  location      TEXT,
  speakers      TEXT
);

-- Notes table (user contributions)
CREATE TABLE IF NOT EXISTS notes (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id        TEXT REFERENCES sessions(session_id),
  free_text         TEXT,
  file_url          TEXT,
  file_name         TEXT,
  file_type         TEXT,
  extracted_text    TEXT,
  extraction_status TEXT,
  extracted_at      TIMESTAMPTZ,
  moderation_status TEXT DEFAULT 'pending',
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read sessions" ON sessions FOR SELECT USING (true);
CREATE POLICY "Public read notes" ON notes FOR SELECT USING (moderation_status = 'approved');
```

If your `notes` table already exists, run this migration:

```sql
ALTER TABLE notes ADD COLUMN IF NOT EXISTS extracted_text TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS extraction_status TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;

-- Remove client-side direct note insertion; notes should be inserted by server API only.
DROP POLICY IF EXISTS "Public insert notes" ON notes;
```

Also create a **Storage bucket** named `conference-notes` with **Public** access enabled.

---

## Content Moderation

Every note submission is sent to Claude Sonnet before saving. The moderation checks for:
- Profanity or inappropriate language
- Sexual content
- Hate speech or personal attacks
- Spam or completely off-topic content

SIOP-relevant content is always approved — including sensitive research topics like harassment, trauma, discrimination, and mental health, which are legitimate academic subjects at this conference.

---

## Questions / Issues

Open an issue on GitHub or reach out to the conference organizer who set this up.

---

*Built for SIOP 2026 · New Orleans · April 29 – May 2, 2026*

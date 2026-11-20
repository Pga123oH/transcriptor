# CLAUDE.md

Guidance for Claude (and humans) working on this repository.

## What this is

**Audio Transcriber**: a single-page, fully client-side web app. You give it a long voice note (up to ~2 hours) and it returns a full transcript, using the user's own OpenRouter API key. Mainly used on a phone browser, sometimes on desktop. Personal use only.

Live site: https://pga123oh.github.io/transcriptor/ (GitHub Pages).

There is **no backend**. Audio is processed in the browser with ffmpeg.wasm and sent directly to OpenRouter. Nothing is uploaded to GitHub or anywhere else.

## Files

| Path | Purpose |
|---|---|
| `index.html` | The whole UI: API key, file picker, language/model, settings, progress, transcript |
| `app.js` | All logic (ES module, no build step) |
| `style.css` | Mobile-first styles, light/dark via `prefers-color-scheme` |
| `vendor/ffmpeg/`, `vendor/util/` | `@ffmpeg/ffmpeg@0.12.15` / `@ffmpeg/util@0.12.2` ESM files, copied verbatim from npm |
| `vendor/core/` | `@ffmpeg/core@0.12.10` **single-threaded** ESM build (`ffmpeg-core.js` + 31 MB `.wasm`) |
| `.github/workflows/pages.yml` | Deploys the static files to GitHub Pages on push |
| `.nojekyll` | Stops Pages from running Jekyll |
| `README.md` | User-facing docs, including the research behind the chunk length |

There is no `package.json`, bundler or framework, and that's intentional: the site is plain files served as-is. Don't edit the files in `vendor/`. To upgrade, re-copy them from the npm packages' `dist/esm/` folders.

## Pipeline (app.js)

1. **Load ffmpeg** (`getFFmpeg`). This uses the single-threaded core because GitHub Pages can't send the COOP/COEP headers that the multi-threaded core (SharedArrayBuffer) needs. Don't switch to `@ffmpeg/core-mt`.
2. **Attach input** (`attachInput`). It mounts the File via WORKERFS (no copy into wasm memory) and falls back to `writeFile`.
3. **Duration**: it runs `ffmpeg -i` and parses `Duration:` from the log. If the header has no duration, it converts the whole file to CBR mp3 once and computes the duration from the file size.
4. **Plan chunks** (`planChunks`):
   - Default length is 5 min.
   - Each chunk after the first starts `OVERLAP_SEC` (5 s) early.
   - A final piece shorter than 30 s is merged into the previous chunk.
   - `nominal` is the timestamp shown in the transcript; `start`/`end` are the actual cut points.
5. **Encode each chunk** to mono, 16 kHz, 32/48 kbps CBR MP3 (`prepareAudio`). That's about 1.2 MB per 5 minutes. Chunks are produced one by one, and transcription starts as soon as chunk 1 is ready.
6. **Transcribe** (`workerLoop` → `transcribeChunk` → `callOpenRouter`). There are two kinds of model:
   - **Chat models with audio input** (Gemini, `callChat`): POST `/api/v1/chat/completions` with a prompt part plus `{type:"input_audio", input_audio:{data:<base64>, format:"mp3"}}`.
   - **Speech-to-text models** (Nemotron, Scribe, Whisper, Deepgram, Voxtral, GPT transcribe…, `callTranscription`): POST `/api/v1/audio/transcriptions` with `{model, input_audio:{data, format:"mp3"}, language:"id"}` and read `json.text`. There's no prompt, so speaker labels are ignored. `language` is an ISO-639-1 code from `LANG_CODES`; it's omitted for unknown or mixed languages.
   - `isSttModel(id)` picks the route. It checks `sttIds`, which starts as `KNOWN_STT` and has OpenRouter's live `?output_modalities=transcription` list added at startup, then falls back to a name regex.
   - Both routes share `postJSON` for error handling, and both return `usage.cost` when the API sends it.
   - Runs 2 chunks in parallel by default (setting: 1 or 2).
   - Retries up to 3 times with exponential backoff on 408/429/5xx/network errors/empty replies. It honours `Retry-After`.
   - 400/401/402/404/413 fail immediately with a hint.
7. **Loop guard**:
   - Gemini sometimes repeats one phrase until it hits the output limit. `findLoop` detects back-to-back repeated n-grams.
   - If a loop is found, or the output was truncated, and the chunk is longer than 60 s, `splitChunk` cuts it in half (with overlap) and both halves are redone.
   - At ≤60 s, `collapseLoops` keeps one copy and adds a note.
   - `max_tokens` is capped per chunk.
   - Don't set `temperature: 0`, because it makes Gemini loop more.
8. **Stitch** (`buildTranscript` + `trimOverlap`). Words that repeat from the 5 s overlap are removed by matching the tail of the previous chunk against the head of the next. A `[hh:mm:ss]` marker goes at each chunk (optional).

## Features to keep working

- **Comparison tab** (`runComparison`):
  - Cuts one snippet with ffmpeg (default 2 min; start time and 1/2/3 min are settable) and sends it to every ticked model, 3 at a time.
  - Shows one card per model with time, word count, cost, loop warning, Copy, and "Use this model" (copies the model ID to the Transcribe tab).
  - Has an audio player for the snippet.
  - **Speed telemetry**: `postJSON` times each request. `waitMs` is send → response headers (upload + processing), `readMs` is the body download, and `uploadBytes` is the payload size. `transcribeChunk` adds `totalMs` (including retries), `attempts` and `retryWaitMs` as `r.telemetry`. Each card shows these, plus realtime factor, provider, and output/thinking tokens for chat models. A "Speed ranking" table sorts the models by total time, and "Copy report" / "Download .md" / "Download .txt" give a Markdown report (`buildReport`): file name, snippet, a table and every transcript. The latest report is saved to `transcriptor:lastReport` after each model finishes, and a "Last benchmark" line in the Comparison card can download or copy it after a reload. Downloads go through `saveFile`. "One model at a time" runs the requests one after another for fairer timing.
  - The main Transcribe run shows elapsed time while it runs, and a summary at the end: total time, realtime factor, and average seconds per chunk. Each chunk chip's tooltip shows its own time.
  - Ticked models and models added by hand are saved in `transcriptor:compareModels`. The defaults are in `COMPARE_DEFAULT`.
  - The model catalog (`catalog`) feeds both the Model datalist and this checklist.
- **Test model (1/5)** only processes the first `ceil(n/5)` chunks (10 → 2, 11 → 3).
- **Retry failed chunks** re-sends only failed chunks. Their audio is kept in memory, so ffmpeg doesn't run again.
- **Cancel** aborts fetches. If ffmpeg is mid-exec, it is terminated and reloaded next time.
- **Persistence (localStorage)**: all access goes through the `store` helper, which never throws.
  - `transcriptor:apiKey` holds the API key.
  - `transcriptor:settings` holds the settings, with a `v` field. Bump it and migrate in `loadSettings` when defaults change.
  - `transcriptor:last` holds the last transcript, restored after a reload.
- **Mobile**:
  - A screen wake lock is held while running.
  - `beforeunload` warns while a job is running.
  - Memory errors are turned into a "use a desktop browser" message (`friendlyError`).
- **Model list**: suggestions are fetched from `https://openrouter.ai/api/v1/models`, filtered to models with `audio` in `input_modalities`, and merged into `catalog`. The main tab shows them in a grouped dropdown (`#modelSelect`: transcription models, then chat models). Its "Other (type a model ID)…" option shows the `#model` text input. `#model` always holds the chosen ID; call `syncModelSelect()` after setting it in code.

## Constraints and decisions

- **Static only**, and it must work on GitHub Pages: no server code, no custom headers, no build step.
- **The API key** stays in localStorage and is only sent to openrouter.ai. Never log it, and never send it or the audio anywhere else.
- **Chunk length**:
  - Gemini allows ~9.5 h of audio per request, and inline requests were 20 MB (later 100 MB).
  - `gpt-4o-transcribe` caps a file at 25 minutes.
  - The real limit is **output tokens** (some models stop at ~8k) and looping on long or noisy audio. Keep the default at 5 minutes. See README for sources.
- **Prompt** (`buildPrompt`): strict verbatim transcription in the chosen language, with no summarising or translating, and only the transcript in the output. There's an optional speaker-label line. Default language: Indonesian. Default model: `google/gemini-2.5-flash` (editable).
- **UI**: single page, mobile-first, 44 px touch targets, a 16 px side gutter, and no horizontal scroll at 390 px wide.

## Running and testing locally

```sh
python3 -m http.server 8765   # then open http://localhost:8765/
```

It must be served over HTTP, not `file://`, because module workers and wasm need it.

There is no test suite in the repo. Changes have been checked with Playwright scripts that:

- intercept `https://openrouter.ai/**` with `page.route` and return fake `choices[0].message.content` (including 503s, 401s and looping text);
- upload audio generated with system `ffmpeg` (e.g. `ffmpeg -f lavfi -i "sine=frequency=300:duration=200" -c:a aac test.m4a`; a 2-hour noise file for stress tests).

Mock `https://openrouter.ai/api/v1/audio/transcriptions` as well, returning `{text, usage}`, and `https://openrouter.ai/api/v1/models**`.

`window.__transcriber` exposes `trimOverlap`, `planChunks`, `findLoop` and `collapseLoops` for quick checks in `page.evaluate`.

Reference numbers: a 2 h, 59 MB m4a splits into 24 chunks in about 35 s in desktop headless Chromium, at about 1.6 MB base64 per request.

## Deployment

A push to `main` or `claude/audio-transcriber-app-2f9fwr` runs `.github/workflows/pages.yml`, which copies `index.html app.js style.css vendor .nojekyll` into `_site` and deploys it. **If you add a new top-level file the page needs, add it to the `cp` line in the workflow.** The repo is public, and Pages source is set to "GitHub Actions". GitHub Pages may cache the old version for ~10 minutes after a deploy.

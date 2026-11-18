# Audio Transcriber

A static web page that turns long voice notes (up to ~2 hours) into a full transcript using your own OpenRouter API key.

Everything runs in your browser: the audio is split and converted locally with ffmpeg.wasm, then sent straight to OpenRouter. There is no backend, and nothing is uploaded to GitHub.

## How it works

1. The file (m4a, mp3, wav, ogg, WhatsApp .opus, …) is opened in the browser with ffmpeg.wasm.
2. It is cut into chunks (default **5 minutes**) with a 5-second overlap. Each chunk is re-encoded to mono, 16 kHz, 32 kbps MP3 (about 1.2 MB, or 1.6 MB as base64).
3. Each chunk is sent to `https://openrouter.ai/api/v1/chat/completions` as an `input_audio` part, two at a time by default. A failed chunk is retried up to 3 times with backoff.
4. The results are stitched together. Words repeated in the overlap are trimmed, and a `[hh:mm:ss]` marker starts each chunk.
5. You can copy the transcript or download it as a .txt file. The last transcript is also kept in localStorage in case the tab reloads.

## Chunk length

Different models accept different amounts of audio, so the default uses the smallest limit that matters:

| Limit | Source |
|---|---|
| Gemini: up to 9.5 h of audio per request; 20 MB inline request (raised to 100 MB in 2026) | Google Gemini API docs |
| OpenAI `gpt-4o-transcribe`: max 1500 s (25 min) per file | OpenAI API error / community reports |
| OpenRouter: no global audio cap, but the provider has to answer before the timeout; long files should be split | OpenRouter audio/STT docs |
| **Output tokens**: each chunk's transcript must fit in the model's output limit (8k tokens on some models). 10 min of fast Indonesian speech is ~1.5–2k words ≈ 3–5k tokens | estimate |

Any length up to ~10 minutes is under all of these limits. The default is 5 minutes because in real tests Gemini sometimes got stuck repeating one phrase on 10-minute chunks of noisy audio (a known Gemini failure). Shorter chunks loop less, and the cost is the same since audio is billed per second.

**Repetition loops:** the app checks every result for a phrase repeated back to back. If it finds one (or the output was cut off), it splits that chunk in half and transcribes both halves again, down to 1 minute. If a 1-minute piece still loops, the repeats are removed and the chunk is flagged. The app also leaves temperature at the model default, because Google notes low temperature makes Gemini loop more, and caps output tokens so a loop can't run up the bill. You can change the length in **More settings**. If a chunk's output gets cut off, the app flags it and suggests a shorter chunk length.

## Hosting on GitHub Pages

GitHub Pages only serves the static files (HTML/JS/wasm). Your audio never goes to GitHub, and the browser talks to OpenRouter directly, so Pages is enough.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that, every push redeploys via `.github/workflows/pages.yml`.

The single-threaded ffmpeg.wasm build is used on purpose. It doesn't need the COOP/COEP headers that GitHub Pages can't set.

## Notes

- The API key is stored only in this browser's localStorage and is sent only to openrouter.ai. That's fine for personal use, but don't share a deployed page with your key saved in it.
- The first visit downloads the ~31 MB audio engine. After that it's cached.
- Keep the tab open and the screen on. The app asks for a screen wake lock where the browser supports it.
- Very large files on phones can hit memory limits. If that happens, the app shows an error and suggests using a desktop browser.

## Local run

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

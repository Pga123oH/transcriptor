import { FFmpeg } from "./vendor/ffmpeg/index.js";

// ---------- constants ----------
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const STT_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const MODELS_URL = "https://openrouter.ai/api/v1/models";

// Dedicated speech-to-text models use /audio/transcriptions instead of chat completions.
// This list is a fallback; the live list from OpenRouter (output_modalities=transcription) is merged in at startup.
const KNOWN_STT = [
  { id: "nvidia/nemotron-3.5-transcribe", name: "NVIDIA Nemotron 3.5 Transcribe" },
  { id: "elevenlabs/scribe-v2", name: "ElevenLabs Scribe v2" },
  { id: "elevenlabs/scribe-v2-medical", name: "ElevenLabs Scribe v2 Medical" },
  { id: "openai/whisper-large-v3-turbo", name: "Whisper Large V3 Turbo" },
  { id: "openai/whisper-large-v3", name: "Whisper Large V3" },
  { id: "openai/gpt-transcribe", name: "OpenAI GPT Transcribe" },
  { id: "openai/gpt-4o-transcribe", name: "OpenAI GPT-4o Transcribe" },
  { id: "openai/gpt-4o-mini-transcribe", name: "OpenAI GPT-4o Mini Transcribe" },
  { id: "deepgram/nova-3", name: "Deepgram Nova-3" },
  { id: "mistralai/voxtral-small-transcribe-3-0", name: "Mistral Voxtral Small Transcribe" },
  { id: "mistralai/voxtral-mini-transcribe-3-0", name: "Mistral Voxtral Mini Transcribe" },
  { id: "microsoft/mai-transcribe-2", name: "Microsoft MAI-Transcribe 2" },
  { id: "openai/whisper-1", name: "OpenAI Whisper-1" },
];
const KNOWN_CHAT_AUDIO = [
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
];
// Checked by default in the Comparison tab
const COMPARE_DEFAULT = ["google/gemini-2.5-flash", "nvidia/nemotron-3.5-transcribe", "elevenlabs/scribe-v2",
  "elevenlabs/scribe-v2-medical", "openai/whisper-large-v3-turbo", "openai/gpt-4o-mini-transcribe"];
const sttIds = new Set(KNOWN_STT.map((m) => m.id));
function isSttModel(id) {
  return sttIds.has(id) || /transcribe|whisper|scribe|deepgram|nova-\d|parakeet|chirp|(^|[/-])(asr|stt)([/-]|$)/i.test(id);
}
// ISO-639-1 codes for the language field of the transcription endpoint (unknown / mixed → auto-detect)
const LANG_CODES = { indonesian: "id", "bahasa indonesia": "id", english: "en", javanese: "jv", sundanese: "su", malay: "ms",
  japanese: "ja", chinese: "zh", mandarin: "zh", korean: "ko", arabic: "ar", dutch: "nl", spanish: "es", french: "fr", german: "de" };
const langCode = (name) => LANG_CODES[String(name).trim().toLowerCase()] || null;
const OVERLAP_SEC = 5;          // each chunk starts 5 s before its nominal start
const MIN_TAIL_SEC = 30;        // a final piece shorter than this is merged into the previous chunk
const MAX_RETRIES = 3;          // retries after the first attempt
const MIN_SPLIT_SEC = 60;       // a looping chunk longer than this is split in half and redone
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const LS = { key: "transcriptor:apiKey", settings: "transcriptor:settings", last: "transcriptor:last", cmp: "transcriptor:compareModels" };

const $ = (id) => document.getElementById(id);
const el = {
  apiKey: $("apiKey"), toggleKey: $("toggleKey"), clearKey: $("clearKey"),
  file: $("file"), fileInfo: $("fileInfo"),
  language: $("language"), model: $("model"), models: $("models"),
  chunkMin: $("chunkMin"), concurrency: $("concurrency"), bitrate: $("bitrate"),
  speakers: $("speakers"), timestamps: $("timestamps"),
  start: $("start"), test: $("test"), cancel: $("cancel"),
  progressCard: $("progressCard"), statusText: $("statusText"), statusPct: $("statusPct"),
  progress: $("progress"), chunkList: $("chunkList"), error: $("error"),
  resultCard: $("resultCard"), copy: $("copy"), download: $("download"), retry: $("retry"),
  transcript: $("transcript"), modelKind: $("modelKind"),
  tabs: document.querySelectorAll(".tab"),
  cmpFile: $("cmpFile"), cmpStart: $("cmpStart"), cmpLen: $("cmpLen"), cmpLanguage: $("cmpLanguage"),
  cmpModels: $("cmpModels"), cmpAdd: $("cmpAdd"), cmpAddBtn: $("cmpAddBtn"),
  cmpRun: $("cmpRun"), cmpCancel: $("cmpCancel"), cmpStatus: $("cmpStatus"),
  cmpResults: $("cmpResults"), cmpAudio: $("cmpAudio"), cmpCards: $("cmpCards"),
  cmpSerial: $("cmpSerial"), cmpRankWrap: $("cmpRankWrap"), cmpRank: $("cmpRank"), cmpReport: $("cmpReport"),
};

// ---------- storage helpers (never throw) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* quota or private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- state ----------
let ffmpeg = null;
let ffmpegLog = [];
let job = null; // { fileName, settings, chunks, abort, running }
let wakeLock = null;

// ---------- utils ----------
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
function fmtBytes(b) {
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
});
function toBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}
function isMemoryError(err) {
  const m = String(err?.message || err || "").toLowerCase();
  return /memory|array buffer allocation|oom|out of bounds|aborted\(\)|rangeerror/.test(m);
}
function friendlyError(err) {
  if (isMemoryError(err)) {
    return "The browser ran out of memory while processing the audio. This happens with big files on phones. " +
      "Try a desktop browser (Chrome, Edge, Firefox) or a shorter / smaller file.";
  }
  return String(err?.message || err);
}

// ---------- settings ----------
function readSettings() {
  return {
    language: el.language.value.trim() || "Indonesian",
    model: el.model.value.trim() || "google/gemini-2.5-flash",
    chunkSec: Math.min(30, Math.max(1, Number(el.chunkMin.value) || 5)) * 60,
    concurrency: Number(el.concurrency.value) === 1 ? 1 : 2,
    bitrate: Number(el.bitrate.value) === 48 ? 48 : 32,
    speakers: el.speakers.checked,
    timestamps: el.timestamps.checked,
  };
}
function saveSettings() {
  const s = readSettings();
  store.set(LS.settings, JSON.stringify({ ...s, chunkMin: s.chunkSec / 60, v: 2 }));
}
function loadSettings() {
  const key = store.get(LS.key);
  if (key) el.apiKey.value = key;
  try {
    const s = JSON.parse(store.get(LS.settings) || "null");
    if (!s) return;
    if ((s.v || 1) < 2) { delete s.chunkMin; delete s.concurrency; } // new defaults after the loop fix
    if (s.language) el.language.value = s.language;
    if (s.model) el.model.value = s.model;
    if (s.chunkMin) el.chunkMin.value = s.chunkMin;
    if (s.concurrency) el.concurrency.value = String(s.concurrency);
    if (s.bitrate) el.bitrate.value = String(s.bitrate);
    el.speakers.checked = !!s.speakers;
    el.timestamps.checked = s.timestamps !== false;
  } catch { /* ignore */ }
}

// ---------- ffmpeg ----------
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  setStatus("Loading audio engine (≈31 MB, first time only)…");
  const f = new FFmpeg();
  f.on("log", ({ message }) => {
    ffmpegLog.push(message);
    if (ffmpegLog.length > 400) ffmpegLog.splice(0, 200);
  });
  const base = new URL("./vendor/core/", import.meta.url).href;
  await f.load({ coreURL: base + "ffmpeg-core.js", wasmURL: base + "ffmpeg-core.wasm" });
  ffmpeg = f;
  return f;
}
function killFFmpeg() {
  if (ffmpeg) { try { ffmpeg.terminate(); } catch { /* ignore */ } }
  ffmpeg = null;
}
async function safeDelete(f, path) { try { await f.deleteFile(path); } catch { /* ignore */ } }

function parseDuration(lines) {
  for (const line of lines) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

/** Puts the file into ffmpeg's filesystem. Prefers WORKERFS (no copy into wasm memory). */
async function attachInput(f, file) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".bin").toLowerCase();
  try {
    await f.createDir("/in");
  } catch { /* exists */ }
  try {
    const named = new File([file], "input" + ext, { type: file.type });
    await f.mount("WORKERFS", { files: [named] }, "/in");
    return { path: "/in/input" + ext, cleanup: async () => { try { await f.unmount("/in"); } catch { /* ignore */ } } };
  } catch {
    const path = "/input" + ext;
    const data = new Uint8Array(await file.arrayBuffer());
    await f.writeFile(path, data);
    return { path, cleanup: () => safeDelete(f, path) };
  }
}

/** Run ffmpeg; throw with the tail of the log if it fails. */
async function run(f, args) {
  const from = ffmpegLog.length;
  const code = await f.exec(args);
  if (code !== 0) {
    const tail = ffmpegLog.slice(from).slice(-6).join("\n");
    throw new Error("ffmpeg failed (code " + code + "):\n" + tail);
  }
}

function planChunks(duration, chunkSec) {
  let n = Math.max(1, Math.ceil(duration / chunkSec));
  if (n > 1 && duration - (n - 1) * chunkSec < MIN_TAIL_SEC) n -= 1;
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const nominal = i * chunkSec;
    const start = i === 0 ? 0 : nominal - OVERLAP_SEC;
    const end = i === n - 1 ? null : nominal + chunkSec; // null = to the end
    chunks.push({ index: i, nominal, start, end, audio: null, status: "pending", text: "", error: "", warn: "", attempts: 0 });
  }
  return chunks;
}

// ---------- OpenRouter ----------
function buildPrompt(s) {
  let p = `Transcribe this audio verbatim in ${s.language}. Do not summarize, translate, or skip anything. ` +
    `Keep filler words and repetitions as spoken. If a part is inaudible, write [inaudible]. ` +
    `If there is no speech, output nothing. `;
  if (s.speakers) p += `Start a new line each time the speaker changes and prefix it with a label like "Speaker 1:", "Speaker 2:". `;
  p += `Output only the transcript, with no introduction, notes, timestamps, or formatting.`;
  return p;
}

function cleanModelText(t) {
  t = String(t || "").trim();
  t = t.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  // drop a one-line preface like "Here is the transcript:" / "Berikut transkripnya:"
  t = t.replace(/^(here('s| is)|berikut|sure|tentu|transcript|transkrip)[^\n]{0,80}:\s*\n+/i, "").trim();
  return t;
}

function combineSignals(a, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException("Request timed out", "TimeoutError")), ms);
  const onAbort = () => c.abort(a.reason);
  if (a.aborted) c.abort(a.reason); else a.addEventListener("abort", onAbort, { once: true });
  return { signal: c.signal, done: () => { clearTimeout(t); a.removeEventListener("abort", onAbort); } };
}

class HttpError extends Error {
  constructor(msg, status, retryable, retryAfterMs) { super(msg); this.status = status; this.retryable = retryable; this.retryAfterMs = retryAfterMs; }
}

async function postJSON(url, body, apiKey, signal) {
  const sig = combineSignals(signal, REQUEST_TIMEOUT_MS);
  const payload = JSON.stringify(body);
  const tSend = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "X-Title": "Audio Transcriber",
      },
      body: payload,
      signal: sig.signal,
    });
  } catch (e) {
    sig.done();
    if (signal.aborted) throw e;
    throw new HttpError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "Request timed out" : "Network error: " + (e?.message || e), 0, true);
  }
  const tHeaders = performance.now();
  let text = "";
  try { text = await res.text(); } finally { sig.done(); }
  const tEnd = performance.now();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }

  if (!res.ok || json?.error) {
    const status = res.ok ? Number(json?.error?.code) || 500 : res.status;
    const msg = json?.error?.message || text.slice(0, 300) || res.statusText;
    const ra = Number(res.headers.get("retry-after"));
    const retryable = status === 408 || status === 429 || status >= 500 || status === 0;
    let hint = "";
    if (status === 401) hint = " — check your API key.";
    else if (status === 402) hint = " — your OpenRouter credits are too low.";
    else if (status === 400 || status === 404) hint = " — the model may not accept audio input (or the model name is wrong). Try another model.";
    else if (status === 413) hint = " — chunk too large; lower the chunk length.";
    throw new HttpError(`HTTP ${status}: ${msg}${hint}`, status, retryable, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
  }
  json = json || {};
  // upload + model processing happen before the response headers arrive; reading the body is the download
  json.__timing = { waitMs: tHeaders - tSend, readMs: tEnd - tHeaders, uploadBytes: payload.length, provider: json.provider || res.headers.get("x-openrouter-provider") || "" };
  return json;
}

async function callOpenRouter(chunk, s, apiKey, signal) {
  return isSttModel(s.model) ? callTranscription(chunk, s, apiKey, signal) : callChat(chunk, s, apiKey, signal);
}

/** Dedicated speech-to-text models: POST /audio/transcriptions → { text, usage } */
async function callTranscription(chunk, s, apiKey, signal) {
  const body = { model: s.model, input_audio: { data: toBase64(chunk.audio), format: "mp3" } };
  const code = langCode(s.language);
  if (code) body.language = code;
  const json = await postJSON(STT_URL, body, apiKey, signal);
  const text = String(json.text ?? json.transcript ?? "").trim();
  return { text, truncated: false, cost: json.usage?.cost, timing: json.__timing };
}

/** Audio-capable chat models (Gemini etc.): prompt + input_audio part */
async function callChat(chunk, s, apiKey, signal) {
  const body = {
    model: s.model,
    // No temperature override: Gemini loops more at low temperature.
    // Cap output so a runaway loop stops early (~1,500 tokens per audio minute is several times normal speech).
    max_tokens: Math.round(4000 + 1500 * (chunkSeconds(chunk) / 60)),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: buildPrompt(s) },
        { type: "input_audio", input_audio: { data: toBase64(chunk.audio), format: "mp3" } },
      ],
    }],
  };
  const json = await postJSON(OPENROUTER_URL, body, apiKey, signal);
  const choice = json?.choices?.[0];
  let content = choice?.message?.content;
  if (Array.isArray(content)) content = content.map((p) => p?.text || "").join("");
  content = cleanModelText(content);
  const finish = choice?.finish_reason || choice?.native_finish_reason || "";
  if (!content && finish !== "stop") throw new HttpError("Model returned an empty response", 200, true);
  return { text: content, truncated: /length|max_tokens/i.test(String(finish)), cost: json.usage?.cost, timing: json.__timing,
    outTokens: json.usage?.completion_tokens, reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens };
}

async function transcribeChunk(chunk, s, apiKey, signal, onUpdate = render) {
  const t0 = performance.now();
  let retryWaitMs = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    chunk.attempts = attempt + 1;
    try {
      const r = await callOpenRouter(chunk, s, apiKey, signal);
      r.telemetry = { ...(r.timing || {}), totalMs: performance.now() - t0, attempts: attempt + 1, retryWaitMs };
      chunk.ms = r.telemetry.totalMs;
      return r;
    } catch (e) {
      if (signal.aborted) throw e;
      if (!(e instanceof HttpError) || !e.retryable || attempt === MAX_RETRIES) throw e;
      const wait = e.retryAfterMs || 2000 * 2 ** attempt + Math.random() * 1000;
      chunk.error = `${e.message} — retrying (${attempt + 1}/${MAX_RETRIES})…`;
      onUpdate();
      retryWaitMs += wait;
      await sleep(wait, signal);
    }
  }
  throw new Error("unreachable");
}

// ---------- repetition-loop detection ----------
/** Finds a phrase (1–12 words) repeated back to back many times. Returns {start,end} char range or null. */
export function findLoop(text) {
  const toks = [...text.matchAll(/\S+/g)].map((m) => ({ w: norm(m[0]), s: m.index, e: m.index + m[0].length })).filter((t) => t.w);
  const w = toks.map((t) => t.w);
  for (let n = 1; n <= 12; n++) {
    const minReps = n === 1 ? 10 : n === 2 ? 7 : 5; // "sampai sampai sampai" is fine; 10× is not
    for (let i = 0; i + 2 * n <= w.length; i++) {
      let reps = 1;
      let j = i + n;
      while (j + n <= w.length && w.slice(j, j + n).every((x, k) => x === w[i + k])) { reps++; j += n; }
      if (reps >= minReps && reps * n >= 25) return { start: toks[i].s, keepEnd: toks[i + n - 1].e, end: toks[j - 1].e, reps };
      if (reps > 1) i = j - n; // skip past this run
    }
  }
  return null;
}
/** Collapses every detected loop to a single copy plus a note. */
export function collapseLoops(text) {
  for (let guard = 0; guard < 20; guard++) {
    const l = findLoop(text);
    if (!l) break;
    text = text.slice(0, l.keepEnd) + ` [model repeated this ${l.reps}× — removed; audio here may be missing]` + text.slice(l.end);
  }
  return text;
}
function chunkSeconds(c) {
  return (c.end ?? job?.duration ?? c.start + 600) - c.start;
}

/** Cut a chunk's audio in two (with the usual overlap) and put both halves in its place. */
async function splitChunk(c) {
  const f = await getFFmpeg();
  const total = chunkSeconds(c);
  const mid = c.nominal + Math.round((c.start + total - c.nominal) / 2);
  const relMid = mid - c.start;
  const id = Math.random().toString(36).slice(2);
  await f.writeFile(`/split${id}.mp3`, c.audio);
  const cut = async (from, dur, out) => {
    const args = ["-hide_banner", "-ss", String(from), "-i", `/split${id}.mp3`];
    if (dur != null) args.push("-t", String(dur));
    args.push("-c", "copy", out);
    await run(f, args);
    const data = await f.readFile(out);
    await safeDelete(f, out);
    return data;
  };
  try {
    const a = await cut(0, relMid, `/a${id}.mp3`);
    const b = await cut(relMid - OVERLAP_SEC, null, `/b${id}.mp3`);
    const base = { status: "ready", text: "", error: "", warn: "", attempts: 0, splitDepth: (c.splitDepth || 0) + 1 };
    const first = { ...base, nominal: c.nominal, start: c.start, end: mid, audio: a };
    const second = { ...base, nominal: mid, start: mid - OVERLAP_SEC, end: c.end, audio: b };
    const i = job.chunks.indexOf(c);
    job.chunks.splice(i, 1, first, second);
    job.chunks.forEach((x, k) => { x.index = k; });
    return [first, second];
  } finally {
    await safeDelete(f, `/split${id}.mp3`);
  }
}

// ---------- stitching ----------
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Remove from the start of `next` the words that repeat the end of `prev` (the 5 s overlap). */
export function trimOverlap(prev, next) {
  const tokensOf = (t) => [...t.matchAll(/\S+/g)].map((m) => ({ w: norm(m[0]), end: m.index + m[0].length })).filter((x) => x.w);
  const p = tokensOf(prev).slice(-60).map((x) => x.w);
  const n = tokensOf(next).slice(0, 60);
  const nw = n.map((x) => x.w);
  let best = null;
  for (let k = Math.min(p.length, nw.length, 40); k >= 3 && !best; k--) {
    for (let pSkip = 0; pSkip <= 3 && !best; pSkip++) {       // prev may end with a cut-off word
      const tail = p.slice(p.length - pSkip - k, p.length - pSkip);
      if (tail.length < k) continue;
      for (let j = 0; j <= 4; j++) {                            // next may start with a cut-off word
        if (j + k > nw.length) break;
        let ok = true;
        for (let i = 0; i < k; i++) if (tail[i] !== nw[j + i]) { ok = false; break; }
        if (ok) { best = j + k; break; }
      }
    }
  }
  if (!best) return next;
  return next.slice(n[best - 1].end).replace(/^[\s,.;:!?…-]+/, "");
}

function buildTranscript() {
  if (!job) return "";
  const out = [];
  let prevText = null;
  for (const c of job.chunks) {
    const marker = job.settings.timestamps ? `[${fmtTime(c.nominal)}]\n` : "";
    if (c.status === "done") {
      const body = prevText != null && c.index > 0 ? trimOverlap(prevText, c.text) : c.text;
      out.push(marker + body);
      prevText = c.text;
    } else {
      prevText = null;
      if (c.status === "failed") out.push(`${marker}[Chunk ${c.index + 1} failed: ${c.error}]`);
      else if (job.running) out.push(`${marker}…`);
    }
  }
  return out.join("\n\n").trim() + "\n";
}

// ---------- UI ----------
function setStatus(text, pct) {
  el.progressCard.hidden = false;
  el.statusText.textContent = text;
  if (pct != null) { el.progress.value = pct; el.statusPct.textContent = Math.round(pct) + "%"; }
}

function render() {
  if (!job) return;
  const chunks = job.chunks;
  const n = chunks.length;
  el.chunkList.innerHTML = "";
  for (const c of chunks) {
    const li = document.createElement("li");
    const range = `${fmtTime(c.nominal)}`;
    const icon = { pending: "", preparing: "…", ready: "", running: "⟳", done: "✓", failed: "✗" }[c.status] || "";
    li.textContent = `#${c.index + 1} ${range} ${icon}`.trim();
    li.className = c.status === "done" && c.warn ? "warn" : c.status;
    li.title = (c.error || c.warn || c.status) + (c.ms ? ` · ${(c.ms / 1000).toFixed(1)} s` : "");
    el.chunkList.appendChild(li);
  }
  const done = chunks.filter((c) => c.status === "done").length;
  const failed = chunks.filter((c) => c.status === "failed");
  const running = chunks.filter((c) => c.status === "running");
  const prepared = chunks.filter((c) => c.audio || c.status === "done" || c.status === "failed").length;

  if (job.running) {
    const pct = ((done + failed.length) / n) * 90 + (prepared / n) * 10;
    let msg;
    if (running.length) {
      const ids = running.map((c) => c.index + 1);
      const r = running[0];
      msg = `Chunk ${ids.join(" & ")} of ${n} — transcribing` + (r.attempts > 1 ? ` (attempt ${r.attempts})` : "");
    } else if (prepared < n) msg = `Preparing chunk ${prepared + 1} of ${n}…`;
    else msg = `Chunk ${Math.min(done + failed.length + 1, n)} of ${n}`;
    setStatus((job.testOnly ? "Test: " : "") + msg, pct);
    showElapsed();
  } else {
    setStatus((job.testOnly ? `Test of first ${n} chunk${n > 1 ? "s" : ""} — ` : "") + (failed.length ? `Finished with ${failed.length} failed chunk${failed.length > 1 ? "s" : ""}` : `Done — ${n} chunk${n > 1 ? "s" : ""}`) + timingSummary(), 100);
  }

  const warnings = chunks.filter((c) => c.warn).map((c) => `Chunk ${c.index + 1}: ${c.warn}`);
  const errs = failed.map((c) => `Chunk ${c.index + 1} (${fmtTime(c.nominal)}) failed: ${c.error}`);
  const msgs = [...errs, ...warnings];
  el.error.hidden = msgs.length === 0;
  el.error.textContent = msgs.join("\n");

  el.resultCard.hidden = done === 0 && failed.length === 0;
  el.transcript.textContent = buildTranscript();
  el.retry.hidden = job.running || failed.length === 0 || failed.some((c) => !c.audio);
  persist();
}

function fmtDur(ms) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
function showElapsed() {
  if (!job?.t0) return;
  el.statusPct.textContent = `${Math.round(el.progress.value)}% · ${fmtDur(performance.now() - job.t0)}`;
}
/** " in 4:31 · 13× realtime · avg 21 s per chunk" for the finished run */
function timingSummary() {
  if (!job?.elapsedMs) return "";
  const done = job.chunks.filter((c) => c.status === "done" && c.ms);
  const last = job.chunks[job.chunks.length - 1];
  const audioSec = job.testOnly ? (last?.end ?? job.duration ?? 0) : (job.duration ?? 0);
  const parts = [` in ${fmtDur(job.elapsedMs)}`];
  if (audioSec && !job.retryRun) parts.push(`${(audioSec / (job.elapsedMs / 1000)).toFixed(1)}× realtime`);
  if (done.length) parts.push(`avg ${(done.reduce((a, c) => a + c.ms, 0) / done.length / 1000).toFixed(1)} s per chunk`);
  return parts.join(" · ");
}

function persist() {
  if (!job) return;
  const done = job.chunks.some((c) => c.status === "done");
  if (!done) return;
  store.set(LS.last, JSON.stringify({ fileName: job.fileName, savedAt: Date.now(), text: buildTranscript() }));
}

function setBusy(busy) {
  el.start.disabled = busy;
  el.test.disabled = busy;
  el.cmpRun.disabled = busy;
  el.file.disabled = busy;
  el.cancel.hidden = !busy;
  el.retry.disabled = busy;
}

async function requestWakeLock() {
  try { if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); wakeLock?.addEventListener("release", () => { wakeLock = null; }); } catch { /* not supported or denied */ }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && job?.running) requestWakeLock(); });

// ---------- pipeline ----------
async function prepareAudio(file, s, signal) {
  const f = await getFFmpeg();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  setStatus("Reading audio file…", 0);
  const input = await attachInput(f, file);
  let src = input.path;
  let cleanupFull = null;
  try {
    // 1) duration from the container header
    const from = ffmpegLog.length;
    try { await f.exec(["-hide_banner", "-i", src]); } catch { /* ffmpeg exits non-zero without output; fine */ }
    let duration = parseDuration(ffmpegLog.slice(from));

    // 2) fallback: no duration in header → convert everything once, measure the CBR mp3
    if (!duration) {
      setStatus("Converting audio (duration unknown in file header)…", 2);
      await run(f, ["-hide_banner", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", s.bitrate + "k", "/full.mp3"]);
      await input.cleanup();
      src = "/full.mp3";
      cleanupFull = () => safeDelete(f, "/full.mp3");
      const data = await f.readFile("/full.mp3");
      duration = (data.length * 8) / (s.bitrate * 1000);
    }
    if (!duration || duration < 0.5) throw new Error("Could not read any audio from this file.");

    job.duration = duration;
    job.chunks = planChunks(duration, s.chunkSec);
    // Test run: only the first 1/5 of the chunks, rounded up (10 → 2, 11 → 3, 1 → 1).
    if (job.testOnly) job.chunks = job.chunks.slice(0, Math.ceil(job.chunks.length / 5));
    render();

    // 3) cut + encode chunk by chunk (mono, 16 kHz, CBR mp3); transcription starts as soon as chunk 1 is ready
    for (const c of job.chunks) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      c.status = "preparing"; render();
      const out = `/chunk${c.index}.mp3`;
      const args = ["-hide_banner", "-ss", String(c.start), "-i", src];
      if (c.end != null) args.push("-t", String(c.end - c.start));
      args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", s.bitrate + "k", "-map_metadata", "-1", out);
      await run(f, args);
      c.audio = await f.readFile(out);
      await safeDelete(f, out);
      if (c.audio.length < 1000) { c.status = "done"; c.text = ""; c.warn = "no audio in this range"; c.audio = null; }
      else c.status = "ready";
      job.wake?.();
      render();
    }
  } finally {
    await input.cleanup();
    if (cleanupFull) await cleanupFull();
  }
}

async function workerLoop(s, apiKey, signal, onlyIdx) {
  for (;;) {
    if (signal.aborted) return;
    const next = job.chunks.find((c) => c.status === "ready" && (!onlyIdx || onlyIdx.has(c)));
    if (!next) {
      const waiting = job.chunks.some((c) => (c.status === "pending" || c.status === "preparing" || c.status === "running") && (!onlyIdx || onlyIdx.has(c)));
      if (!waiting) return;
      await new Promise((r) => { job.wake = r; setTimeout(r, 500); });
      continue;
    }
    next.status = "running"; next.error = ""; next.warn = ""; render();
    try {
      const r = await transcribeChunk(next, s, apiKey, signal);
      const looped = !!findLoop(r.text);
      if ((looped || r.truncated) && chunkSeconds(next) > MIN_SPLIT_SEC && next.audio) {
        // The model got stuck repeating itself (or ran out of output). Redo this part as two shorter pieces.
        next.status = "preparing"; next.error = "model repeated itself — splitting into shorter pieces"; render();
        const parts = await splitChunk(next);
        if (onlyIdx) parts.forEach((p) => onlyIdx.add(p));
        render();
        continue;
      }
      next.text = looped ? collapseLoops(r.text) : r.text;
      next.status = "done";
      next.warn = looped ? "model got stuck repeating a phrase even on a short piece — repeats removed, some words may be missing"
        : r.truncated ? "output was cut off by the model's length limit — lower the chunk length and retry" : "";
      if (!r.text) next.warn = "model returned no speech for this chunk";
    } catch (e) {
      if (signal.aborted) { next.status = "ready"; return; }
      next.status = "failed";
      next.error = friendlyError(e);
    }
    render();
  }
}

async function start({ retryOnly = false, testOnly = false } = {}) {
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) { alert("Paste your OpenRouter API key first."); el.apiKey.focus(); return; }
  store.set(LS.key, apiKey);
  saveSettings();

  let onlyIdx = null;
  if (retryOnly) {
    if (!job) return;
    job.settings = { ...readSettings(), chunkSec: job.settings.chunkSec, bitrate: job.settings.bitrate, timestamps: el.timestamps.checked };
    onlyIdx = new Set(job.chunks.filter((c) => c.status === "failed" && c.audio));
    for (const c of onlyIdx) { c.status = "ready"; c.error = ""; }
  } else {
    const file = el.file.files?.[0];
    if (!file) { alert("Choose an audio file first."); return; }
    job = { fileName: file.name, file, settings: readSettings(), chunks: [], running: true, prepDone: false, testOnly };
  }

  document.getElementById("restoredNote")?.remove();
  const abort = new AbortController();
  job.abort = abort;
  job.running = true;
  job.t0 = performance.now();
  job.elapsedMs = 0;
  job.retryRun = retryOnly;
  clearInterval(job.timer);
  job.timer = setInterval(showElapsed, 1000);
  setBusy(true);
  el.error.hidden = true;
  el.resultCard.hidden = true;
  await requestWakeLock();
  const s = job.settings;

  try {
    if (retryOnly) {
      job.prepDone = true;
      render();
      await Promise.all(Array.from({ length: s.concurrency }, () => workerLoop(s, apiKey, abort.signal, onlyIdx)));
    } else {
      job.prepDone = false;
      const prep = prepareAudio(job.file, s, abort.signal).finally(() => { job.prepDone = true; job.wake?.(); });
      const workers = (async () => {
        // wait until the chunk plan exists
        while (!job.chunks.length && !job.prepDone) await new Promise((r) => { job.wake = r; setTimeout(r, 300); });
        await Promise.all(Array.from({ length: s.concurrency }, () => workerLoop(s, apiKey, abort.signal, null)));
      })();
      await prep; // throws on ffmpeg errors
      await workers;
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      abort.abort();
      killFFmpeg(); // ffmpeg may be in a bad state (e.g. out of memory) — reload next time
      el.progressCard.hidden = false;
      el.error.hidden = false;
      el.error.textContent = friendlyError(e);
      job.running = false;
      clearInterval(job.timer);
      job.elapsedMs = performance.now() - job.t0;
      setBusy(false);
      releaseWakeLock();
      if (job.chunks.some((c) => c.status === "done")) { el.resultCard.hidden = false; el.transcript.textContent = buildTranscript(); }
      el.statusText.textContent = "Stopped because of an error";
      return;
    }
  }
  job.running = false;
  clearInterval(job.timer);
  job.elapsedMs = performance.now() - job.t0;
  setBusy(false);
  releaseWakeLock();
  if (abort.signal.aborted) {
    for (const c of job.chunks) if (c.status === "running" || c.status === "preparing") c.status = c.audio ? "ready" : "pending";
    render();
    el.statusText.textContent = "Cancelled";
    return;
  }
  render();
}

function cancel() {
  if (!job?.running) return;
  job.abort?.abort();
  // ffmpeg can't be interrupted mid-exec; terminate and reload on next run
  if (!job.prepDone) killFFmpeg();
}

// ---------- model catalog ----------
/** id → { id, name, stt } ; seeded with known models, extended with OpenRouter's live list */
const catalog = new Map();
for (const m of KNOWN_CHAT_AUDIO) catalog.set(m.id, { ...m, stt: false });
for (const m of KNOWN_STT) catalog.set(m.id, { ...m, stt: true });

function refreshModelUI() {
  el.models.innerHTML = "";
  const list = [...catalog.values()].sort((x, y) => Number(x.stt) - Number(y.stt) || x.name.localeCompare(y.name));
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m.id;
    o.label = `${m.name} · ${m.stt ? "transcription" : "chat"}`;
    el.models.appendChild(o);
  }
  renderCompareModels();
  showModelKind();
}
function showModelKind() {
  const id = el.model.value.trim();
  el.modelKind.textContent = !id ? "" : isSttModel(id)
    ? "Transcription model — sent to OpenRouter's speech-to-text endpoint. The speaker-label option is ignored."
    : "Chat model with audio input — uses the transcription prompt.";
}

async function loadModelList() {
  const get = async (url) => { try { const r = await fetch(url); return r.ok ? (await r.json()).data || [] : []; } catch { return []; } };
  const [all, stt] = await Promise.all([get(MODELS_URL), get(MODELS_URL + "?output_modalities=transcription")]);
  for (const m of all) {
    if ((m.architecture?.input_modalities || []).includes("audio") && !catalog.has(m.id)) catalog.set(m.id, { id: m.id, name: m.name || m.id, stt: false });
  }
  for (const m of stt) {
    sttIds.add(m.id);
    catalog.set(m.id, { id: m.id, name: m.name || m.id, stt: true });
  }
  refreshModelUI();
}

// ---------- tabs ----------
function showTab(id) {
  for (const b of el.tabs) {
    const on = b.dataset.tab === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
    $(b.dataset.tab).hidden = !on;
  }
}
for (const b of el.tabs) b.addEventListener("click", () => {
  if (b.dataset.tab === "tabCompare" && !cmp.running) el.cmpLanguage.value = el.language.value;
  showTab(b.dataset.tab);
});

// ---------- comparison ----------
const cmp = { running: false, abort: null, audioUrl: null, selected: new Set(), extra: [], rows: [], meta: null };
try {
  const saved = JSON.parse(store.get(LS.cmp) || "null");
  if (saved) { cmp.selected = new Set(saved.selected || []); cmp.extra = saved.extra || []; }
  else cmp.selected = new Set(COMPARE_DEFAULT);
} catch { cmp.selected = new Set(COMPARE_DEFAULT); }
for (const id of cmp.extra) if (!catalog.has(id)) catalog.set(id, { id, name: id, stt: isSttModel(id) });
const saveCmp = () => store.set(LS.cmp, JSON.stringify({ selected: [...cmp.selected], extra: cmp.extra }));

function renderCompareModels() {
  el.cmpModels.innerHTML = "";
  const list = [...catalog.values()].sort((x, y) =>
    Number(cmp.selected.has(y.id)) - Number(cmp.selected.has(x.id)) || Number(x.stt) - Number(y.stt) || x.name.localeCompare(y.name));
  for (const m of list) {
    const row = document.createElement("label");
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: cmp.selected.has(m.id) });
    cb.addEventListener("change", () => { cb.checked ? cmp.selected.add(m.id) : cmp.selected.delete(m.id); saveCmp(); });
    const name = document.createElement("span");
    name.className = "mname";
    name.textContent = m.name;
    const idEl = document.createElement("span");
    idEl.className = "mid";
    idEl.textContent = m.id;
    name.appendChild(idEl);
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = m.stt ? "transcription" : "chat";
    row.append(cb, name, tag);
    el.cmpModels.appendChild(row);
  }
}

function parseMmSs(v) {
  const parts = String(v).trim().split(":").map((x) => Number(x));
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

function cmpCard(model) {
  const card = document.createElement("article");
  card.className = "cmp-card";
  const m = catalog.get(model) || { name: model };
  card.innerHTML = `<h3></h3><div class="mid"></div><div class="meta">Waiting…</div><dl hidden></dl><div class="warn" hidden></div><div class="err" hidden></div><pre class="transcript" hidden></pre>
    <div class="actions wrap" hidden><button type="button" data-act="copy">Copy</button><button type="button" data-act="use">Use this model</button></div>`;
  card.querySelector("h3").textContent = m.name;
  card.querySelector(".mid").textContent = model;
  card.querySelector('[data-act="copy"]').addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(card.querySelector("pre").textContent); e.target.textContent = "Copied ✓"; } catch { /* ignore */ }
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  });
  card.querySelector('[data-act="use"]').addEventListener("click", () => {
    el.model.value = model; saveSettings(); showModelKind(); showTab("tabMain");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  el.cmpCards.appendChild(card);
  return card;
}

function sortedRows() {
  return cmp.rows.filter((r) => r.status !== "running" && r.status !== "cancelled")
    .sort((a, b) => (a.status === "failed") - (b.status === "failed") || a.totalS - b.totalS);
}

function renderRanking() {
  const sorted = sortedRows();
  if (!sorted.length) return;
  const t = el.cmpRank;
  t.innerHTML = "<thead><tr><th>#</th><th>Model</th><th class=num>Total</th><th class=num>Realtime</th><th class=num>Server</th><th class=num>Words</th><th>Note</th></tr></thead>";
  const tb = document.createElement("tbody");
  sorted.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (r.status === "failed") tr.className = "bad";
    const cells = r.status === "failed"
      ? [String(i + 1), r.name, `${r.totalS.toFixed(1)} s`, "—", "—", "—", "failed"]
      : [String(i + 1), r.name, `${r.totalS.toFixed(1)} s`, `${r.rtf.toFixed(1)}×`, `${r.serverS.toFixed(1)} s`, String(r.words),
        [r.status === "loop" ? "looped" : "", r.attempts > 1 ? `${r.attempts} tries` : ""].filter(Boolean).join(", ")];
    cells.forEach((c, k) => { const td = document.createElement("td"); td.textContent = c; if (k >= 2 && k <= 5) td.className = "num"; tr.appendChild(td); });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  el.cmpRankWrap.hidden = false;
}

function buildReport() {
  const m = cmp.meta || {};
  const rows = sortedRows();
  const f = (x, d = 2) => (x == null || Number.isNaN(x) ? "" : Number(x).toFixed(d));
  const lines = [
    "# Transcription model comparison",
    `Snippet ${fmtTime(m.from || 0)}–${fmtTime((m.from || 0) + (m.realLen || 0))} (${m.realLen} s), language ${m.language}, ` +
      `${m.serial ? "one model at a time" : "3 models in parallel"}, ${m.when ? m.when.toISOString() : ""}`,
    "",
    "| # | Model | Total s | × realtime | Server s | Download s | Attempts | Words | Output tok | Cost $ | Provider | Note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.model} | ${f(r.totalS)} | ${f(r.rtf, 1)} | ${f(r.serverS)} | ${f(r.readS)} | ${r.attempts ?? ""} | ${r.words ?? ""} | ` +
      `${r.outTokens ?? ""}${r.reasoningTokens ? ` (${r.reasoningTokens} thinking)` : ""} | ${r.cost != null ? f(r.cost, 5) : ""} | ${r.provider || ""} | ` +
      `${r.status === "failed" ? "FAILED: " + (r.error || "").replace(/\|/g, "/") : r.status === "loop" ? "looped" : ""} |`);
  });
  for (const r of rows) if (r.text) lines.push("", `## ${r.model}`, "", r.text);
  return lines.join("\n");
}

async function runComparison() {
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) { alert("Paste your OpenRouter API key first."); el.apiKey.focus(); return; }
  store.set(LS.key, apiKey);
  const file = el.cmpFile.files?.[0] || el.file.files?.[0];
  if (!file) { alert("Choose an audio file first."); return; }
  const models = [...cmp.selected];
  if (!models.length) { alert("Tick at least one model."); return; }
  const from = parseMmSs(el.cmpStart.value);
  if (from == null) { alert("Start time should look like 12:30 (minutes:seconds)."); el.cmpStart.focus(); return; }
  if (job?.running) { alert("Wait for the current transcription to finish first."); return; }
  const len = Number(el.cmpLen.value) || 120;

  cmp.running = true;
  cmp.abort = new AbortController();
  const signal = cmp.abort.signal;
  el.cmpRun.disabled = el.start.disabled = el.test.disabled = true;
  el.cmpCancel.hidden = false;
  el.cmpCards.innerHTML = "";
  el.cmpResults.hidden = true;
  el.cmpRankWrap.hidden = true;
  cmp.rows = [];
  await requestWakeLock();

  try {
    el.cmpStatus.textContent = "Cutting the snippet…";
    const f = await getFFmpeg();
    el.cmpStatus.textContent = "Cutting the snippet…";
    const input = await attachInput(f, file);
    let audio;
    try {
      await run(f, ["-hide_banner", "-ss", String(from), "-i", input.path, "-t", String(len), "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "libmp3lame", "-b:a", "32k", "-map_metadata", "-1", "/cmp.mp3"]);
      audio = await f.readFile("/cmp.mp3");
      await safeDelete(f, "/cmp.mp3");
    } finally { await input.cleanup(); }
    if (audio.length < 2000) throw new Error("No audio at that start time — is it past the end of the file?");
    const realLen = Math.round((audio.length * 8) / 32000);

    if (cmp.audioUrl) URL.revokeObjectURL(cmp.audioUrl);
    cmp.audioUrl = URL.createObjectURL(new Blob([audio], { type: "audio/mpeg" }));
    el.cmpAudio.src = cmp.audioUrl;
    el.cmpResults.hidden = false;

    const settings = { ...readSettings(), language: el.cmpLanguage.value.trim() || "Indonesian" };
    const cards = new Map(models.map((m) => [m, cmpCard(m)]));
    let finished = 0;
    const status = () => { el.cmpStatus.textContent = `Snippet ${fmtTime(from)}–${fmtTime(from + realLen)} · ${finished} of ${models.length} models done`; };
    status();

    const queue = [...models];
    const worker = async () => {
      while (queue.length && !signal.aborted) {
        const model = queue.shift();
        const card = cards.get(model);
        const meta = card.querySelector(".meta"), warn = card.querySelector(".warn"), err = card.querySelector(".err"), pre = card.querySelector("pre");
        const piece = { audio, start: 0, end: realLen, attempts: 0, error: "" };
        const row = { model, name: (catalog.get(model) || { name: model }).name, status: "running" };
        cmp.rows.push(row);
        meta.textContent = "Transcribing…";
        const t0 = performance.now();
        const tick = setInterval(() => { if (!piece.error) meta.textContent = `Transcribing… ${((performance.now() - t0) / 1000).toFixed(0)} s`; }, 1000);
        try {
          const r = await transcribeChunk(piece, { ...settings, model }, apiKey, signal, () => { meta.textContent = piece.error; });
          clearInterval(tick);
          const t = r.telemetry;
          const loop = findLoop(r.text);
          const text = loop ? collapseLoops(r.text) : r.text;
          const words = (text.match(/\S+/g) || []).length;
          Object.assign(row, { status: loop ? "loop" : "ok", totalS: t.totalMs / 1000, rtf: realLen / (t.totalMs / 1000), serverS: t.waitMs / 1000,
            readS: t.readMs / 1000, attempts: t.attempts, retryS: t.retryWaitMs / 1000, provider: t.provider, words, cost: r.cost,
            outTokens: r.outTokens, reasoningTokens: r.reasoningTokens, text });
          meta.textContent = [`${row.totalS.toFixed(1)} s`, `${row.rtf.toFixed(1)}× realtime`, `${words} words`, r.cost != null ? `$${Number(r.cost).toFixed(4)}` : null].filter(Boolean).join(" · ");
          const dl = card.querySelector("dl");
          const facts = [
            ["Total", `${row.totalS.toFixed(2)} s`],
            ["Server", `${row.serverS.toFixed(2)} s (upload ${(t.uploadBytes / 1024).toFixed(0)} KB + processing)`],
            ["Download", `${row.readS.toFixed(2)} s`],
            ["Speed", `${row.rtf.toFixed(1)}× realtime · ${(words / row.totalS).toFixed(0)} words/s`],
            ["Attempts", t.attempts > 1 ? `${t.attempts} (waited ${row.retryS.toFixed(1)} s between retries)` : "1"],
            t.provider ? ["Provider", t.provider] : null,
            r.outTokens != null ? ["Output tokens", `${r.outTokens}${r.reasoningTokens ? ` (${r.reasoningTokens} thinking)` : ""}`] : null,
          ].filter(Boolean);
          dl.innerHTML = "";
          for (const [k, v] of facts) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); }
          dl.hidden = false;
          const warns = [];
          if (loop) warns.push(`Got stuck repeating a phrase (${loop.reps}×) — repeats removed.`);
          if (r.truncated) warns.push("Output was cut off.");
          if (!text) warns.push("Returned no text.");
          warn.hidden = !warns.length; warn.textContent = warns.join(" ");
          pre.hidden = !text; pre.textContent = text;
          card.querySelector(".actions").hidden = false;
        } catch (e) {
          clearInterval(tick);
          if (signal.aborted) { meta.textContent = "Cancelled"; row.status = "cancelled"; return; }
          card.classList.add("failed");
          meta.textContent = `Failed after ${((performance.now() - t0) / 1000).toFixed(1)} s`;
          err.hidden = false; err.textContent = friendlyError(e);
          Object.assign(row, { status: "failed", totalS: (performance.now() - t0) / 1000, error: friendlyError(e) });
        }
        finished++; status(); renderRanking();
      }
    };
    cmp.meta = { from, realLen, language: settings.language, serial: el.cmpSerial.checked, when: new Date() };
    await Promise.all(Array.from({ length: el.cmpSerial.checked ? 1 : 3 }, worker));
    if (signal.aborted) el.cmpStatus.textContent = "Cancelled";
    else el.cmpStatus.textContent += " — read them while listening to the snippet above, then tap “Use this model” on the best one.";
  } catch (e) {
    if (!signal.aborted) { killFFmpeg(); el.cmpStatus.textContent = friendlyError(e); }
    else el.cmpStatus.textContent = "Cancelled";
  } finally {
    cmp.running = false;
    el.cmpRun.disabled = el.start.disabled = el.test.disabled = false;
    el.cmpCancel.hidden = true;
    releaseWakeLock();
  }
}

el.cmpRun.addEventListener("click", runComparison);
el.cmpReport.addEventListener("click", async () => {
  const text = buildReport();
  try { await navigator.clipboard.writeText(text); el.cmpReport.textContent = "Copied ✓ — paste it anywhere"; }
  catch { el.cmpReport.textContent = "Couldn't copy"; }
  setTimeout(() => (el.cmpReport.textContent = "Copy report"), 2000);
});
el.cmpCancel.addEventListener("click", () => { cmp.abort?.abort(); });
el.cmpAddBtn.addEventListener("click", () => {
  const id = el.cmpAdd.value.trim();
  if (!id) return;
  if (!catalog.has(id)) { catalog.set(id, { id, name: id, stt: isSttModel(id) }); cmp.extra.push(id); }
  cmp.selected.add(id); saveCmp();
  el.cmpAdd.value = "";
  refreshModelUI();
});
el.model.addEventListener("input", showModelKind);

// ---------- events ----------
el.toggleKey.addEventListener("click", () => {
  const show = el.apiKey.type === "password";
  el.apiKey.type = show ? "text" : "password";
  el.toggleKey.textContent = show ? "Hide" : "Show";
});
el.clearKey.addEventListener("click", () => { store.del(LS.key); el.apiKey.value = ""; });
el.apiKey.addEventListener("change", () => store.set(LS.key, el.apiKey.value.trim()));
for (const x of [el.language, el.model, el.chunkMin, el.concurrency, el.bitrate, el.speakers, el.timestamps]) x.addEventListener("change", saveSettings);
el.timestamps.addEventListener("change", () => { if (job) { job.settings.timestamps = el.timestamps.checked; el.transcript.textContent = buildTranscript(); } });

el.file.addEventListener("change", () => {
  const f = el.file.files?.[0];
  if (!f) { el.fileInfo.textContent = ""; return; }
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  let info = `${f.name} — ${fmtBytes(f.size)}`;
  if (mobile && f.size > 150 * 1024 * 1024) info += " · Large file for a phone; if it fails, use a desktop browser.";
  el.fileInfo.textContent = info;
});
el.start.addEventListener("click", () => start());
el.test.addEventListener("click", () => start({ testOnly: true }));
el.retry.addEventListener("click", () => start({ retryOnly: true }));
el.cancel.addEventListener("click", cancel);

el.copy.addEventListener("click", async () => {
  const text = el.transcript.textContent;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const r = document.createRange(); r.selectNodeContents(el.transcript);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand("copy");
  }
  el.copy.textContent = "Copied ✓";
  setTimeout(() => (el.copy.textContent = "Copy all"), 1500);
});
el.download.addEventListener("click", () => {
  const text = el.transcript.textContent.replace(/\n/g, "\r\n");
  const name = ((job?.fileName || "transcript").replace(/\.[^.]+$/, "")) + ".txt";
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
window.addEventListener("beforeunload", (e) => { if (job?.running || cmp.running) { e.preventDefault(); e.returnValue = ""; } });

// ---------- init ----------
loadSettings();
refreshModelUI();
loadModelList();
try {
  const last = JSON.parse(store.get(LS.last) || "null");
  if (last?.text) {
    el.resultCard.hidden = false;
    el.transcript.textContent = last.text;
    job = null;
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = `Restored last transcript (${last.fileName}, ${new Date(last.savedAt).toLocaleString()}).`;
    note.id = "restoredNote";
    el.resultCard.prepend(note);
  }
} catch { /* ignore */ }

// exposed for tests
window.__transcriber = { trimOverlap, planChunks, findLoop, collapseLoops };

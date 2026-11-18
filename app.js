import { FFmpeg } from "./vendor/ffmpeg/index.js";

// ---------- constants ----------
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const OVERLAP_SEC = 5;          // each chunk starts 5 s before its nominal start
const MIN_TAIL_SEC = 30;        // a final piece shorter than this is merged into the previous chunk
const MAX_RETRIES = 3;          // retries after the first attempt
const MIN_SPLIT_SEC = 60;       // a looping chunk longer than this is split in half and redone
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const LS = { key: "transcriptor:apiKey", settings: "transcriptor:settings", last: "transcriptor:last" };

const $ = (id) => document.getElementById(id);
const el = {
  apiKey: $("apiKey"), toggleKey: $("toggleKey"), clearKey: $("clearKey"),
  file: $("file"), fileInfo: $("fileInfo"),
  language: $("language"), model: $("model"), models: $("models"),
  chunkMin: $("chunkMin"), concurrency: $("concurrency"), bitrate: $("bitrate"),
  speakers: $("speakers"), timestamps: $("timestamps"),
  start: $("start"), cancel: $("cancel"),
  progressCard: $("progressCard"), statusText: $("statusText"), statusPct: $("statusPct"),
  progress: $("progress"), chunkList: $("chunkList"), error: $("error"),
  resultCard: $("resultCard"), copy: $("copy"), download: $("download"), retry: $("retry"),
  transcript: $("transcript"),
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

async function callOpenRouter(chunk, s, apiKey, signal) {
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
  const sig = combineSignals(signal, REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "X-Title": "Audio Transcriber",
      },
      body: JSON.stringify(body),
      signal: sig.signal,
    });
  } catch (e) {
    sig.done();
    if (signal.aborted) throw e;
    throw new HttpError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "Request timed out" : "Network error: " + (e?.message || e), 0, true);
  }
  let text = "";
  try { text = await res.text(); } finally { sig.done(); }
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
    else if (status === 400 || status === 404) hint = " — the model may not accept audio input. Try another model.";
    else if (status === 413) hint = " — chunk too large; lower the chunk length.";
    throw new HttpError(`HTTP ${status}: ${msg}${hint}`, status, retryable, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
  }

  const choice = json?.choices?.[0];
  let content = choice?.message?.content;
  if (Array.isArray(content)) content = content.map((p) => p?.text || "").join("");
  content = cleanModelText(content);
  const finish = choice?.finish_reason || choice?.native_finish_reason || "";
  if (!content && finish !== "stop") throw new HttpError("Model returned an empty response", 200, true);
  return { text: content, truncated: /length|max_tokens/i.test(String(finish)) };
}

async function transcribeChunk(chunk, s, apiKey, signal) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    chunk.attempts = attempt + 1;
    try {
      const r = await callOpenRouter(chunk, s, apiKey, signal);
      return r;
    } catch (e) {
      if (signal.aborted) throw e;
      if (!(e instanceof HttpError) || !e.retryable || attempt === MAX_RETRIES) throw e;
      const wait = e.retryAfterMs || 2000 * 2 ** attempt + Math.random() * 1000;
      chunk.error = `${e.message} — retrying (${attempt + 1}/${MAX_RETRIES})…`;
      render();
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
    li.title = c.error || c.warn || c.status;
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
    setStatus(msg, pct);
  } else {
    setStatus(failed.length ? `Finished with ${failed.length} failed chunk${failed.length > 1 ? "s" : ""}` : `Done — ${n} chunk${n > 1 ? "s" : ""}`, 100);
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

function persist() {
  if (!job) return;
  const done = job.chunks.some((c) => c.status === "done");
  if (!done) return;
  store.set(LS.last, JSON.stringify({ fileName: job.fileName, savedAt: Date.now(), text: buildTranscript() }));
}

function setBusy(busy) {
  el.start.disabled = busy;
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

async function start({ retryOnly = false } = {}) {
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
    job = { fileName: file.name, file, settings: readSettings(), chunks: [], running: true, prepDone: false };
  }

  document.getElementById("restoredNote")?.remove();
  const abort = new AbortController();
  job.abort = abort;
  job.running = true;
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
      setBusy(false);
      releaseWakeLock();
      if (job.chunks.some((c) => c.status === "done")) { el.resultCard.hidden = false; el.transcript.textContent = buildTranscript(); }
      el.statusText.textContent = "Stopped because of an error";
      return;
    }
  }
  job.running = false;
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

// ---------- model list (optional nicety) ----------
async function loadModelList() {
  try {
    const res = await fetch(MODELS_URL);
    if (!res.ok) return;
    const { data } = await res.json();
    const audio = (data || []).filter((m) => (m.architecture?.input_modalities || []).includes("audio"));
    audio.sort((a, b) => (Number(a.pricing?.prompt) || 0) - (Number(b.pricing?.prompt) || 0));
    el.models.innerHTML = "";
    for (const m of audio) {
      const o = document.createElement("option");
      o.value = m.id;
      o.label = m.name || m.id;
      el.models.appendChild(o);
    }
  } catch { /* offline or blocked — the field is free text anyway */ }
}

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
window.addEventListener("beforeunload", (e) => { if (job?.running) { e.preventDefault(); e.returnValue = ""; } });

// ---------- init ----------
loadSettings();
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

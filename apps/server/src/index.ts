import cors from "cors";
import express from "express";
import multer from "multer";
import path from "path";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";

const rootDir = path.resolve(__dirname, "..", "..", "..");
const storageDir = path.join(rootDir, "storage");
const uploadsDir = path.join(storageDir, "uploads");
const jobsDir = path.join(storageDir, "jobs");

const PORT = Number(process.env.PORT ?? 3001);
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "small";

type JobState = "queued" | "ready" | "processing" | "done" | "error";
type JobStep = "upload" | "download" | "extract" | "asr" | "translate" | "convert";
type JobSource = "upload" | "youtube";
type StepTiming = { startMs: number; endMs?: number; durationMs?: number };
type StepTimings = Partial<Record<JobStep, StepTiming>>;

interface Job {
  id: string;
  state: JobState;
  step: JobStep;
  progress: number;
  error?: string;
  asrProcessedSec?: number;
  asrTotalSec?: number;
  asrSpeed?: number;
  originalFilename: string;
  basename: string;
  assetPath: string;
  enSrtPath: string;
  ruSrtPath: string;
  enVttPath: string;
  ruVttPath: string;
  source: JobSource;
  youtubeUrl?: string;
  maxHeight?: number;
  downloadCompleted: boolean;
  processRequested: boolean;
  createdAt: number;
  processingStartedAt?: number;
  processingFinishedAt?: number;
  stepTimings?: StepTimings;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let isProcessing = false;
let activeJobId: string | null = null;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({ dest: uploadsDir });

async function ensureDirs() {
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(jobsDir, { recursive: true });
}

function updateJob(job: Job, patch: Partial<Job>) {
  const current = jobs.get(job.id) ?? job;
  const next = { ...current, ...patch };
  jobs.set(job.id, next);
  return next;
}

function enqueueJob(jobId: string) {
  if (queue.includes(jobId) || activeJobId === jobId) return;
  queue.push(jobId);
  processQueue();
}

function markStepStart(jobId: string, step: JobStep, startProcessing = false) {
  const current = jobs.get(jobId);
  if (!current) return;
  const now = Date.now();
  const timings: StepTimings = { ...(current.stepTimings ?? {}) };
  const existing = timings[step];
  timings[step] = { startMs: existing?.startMs ?? now, endMs: existing?.endMs, durationMs: existing?.durationMs };
  const patch: Partial<Job> = { stepTimings: timings };
  if (startProcessing && !current.processingStartedAt) {
    patch.processingStartedAt = now;
  }
  updateJob(current, patch);
}

function markStepEnd(jobId: string, step: JobStep) {
  const current = jobs.get(jobId);
  if (!current) return;
  const now = Date.now();
  const timings: StepTimings = { ...(current.stepTimings ?? {}) };
  const existing = timings[step];
  const startMs = existing?.startMs ?? now;
  timings[step] = {
    startMs,
    endMs: now,
    durationMs: Math.max(0, now - startMs)
  };
  updateJob(current, { stepTimings: timings });
}

function finalizeProcessing(jobId: string) {
  const current = jobs.get(jobId);
  if (!current) return;
  if (!current.processingFinishedAt && current.processingStartedAt) {
    updateJob(current, { processingFinishedAt: Date.now() });
  }
}

function closeOpenStepOnError(job: Job) {
  const current = jobs.get(job.id) ?? job;
  const timings: StepTimings = { ...(current.stepTimings ?? {}) };
  const step = current.step;
  const existing = timings[step];
  if (existing?.startMs && !existing.endMs) {
    const now = Date.now();
    timings[step] = {
      ...existing,
      endMs: now,
      durationMs: Math.max(0, now - existing.startMs)
    };
    updateJob(current, {
      stepTimings: timings,
      processingFinishedAt: current.processingFinishedAt ?? now
    });
    return;
  }
  if (!current.processingFinishedAt && current.processingStartedAt) {
    updateJob(current, { processingFinishedAt: Date.now() });
  }
}

const STEP_ORDER: JobStep[] = ["upload", "download", "extract", "asr", "translate", "convert"];

function buildStepDurations(job: Job) {
  const out: Record<JobStep, number | null> = {
    upload: null,
    download: null,
    extract: null,
    asr: null,
    translate: null,
    convert: null
  };
  for (const step of STEP_ORDER) {
    const duration = job.stepTimings?.[step]?.durationMs;
    out[step] = Number.isFinite(duration) ? (duration as number) : null;
  }
  return out;
}

function runCommand(cmd: string, args: string[], cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
  });
}

function runCommandCapture(cmd: string, args: string[], cwd?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
  });
}

async function getMediaDurationSeconds(filePath: string) {
  try {
    const output = await runCommandCapture("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nk=1:nw=1",
      filePath
    ]);
    const value = Number.parseFloat(output);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function srtToVtt(srtText: string) {
  const blocks = srtText
    .replace(/\r/g, "")
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean);

  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) continue;
    let timeLineIndex = 0;
    if (/^\d+$/.test(lines[0].trim())) {
      timeLineIndex = 1;
    }
    const timeLine = lines[timeLineIndex];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const textLines = lines.slice(timeLineIndex + 1);
    const vttTime = timeLine.replace(/,/g, ".");
    cues.push(`${vttTime}\n${textLines.join("\n")}`);
  }

  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

function sanitizeBasename(value: string) {
  const raw = value.trim() || "video";
  const cleaned = raw
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "video";
}

function isYouTubeUrl(value: string) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const isYouTubeHost =
      hostname === "youtube.com" ||
      hostname === "www.youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname === "youtu.be" ||
      hostname === "www.youtu.be";
    if (!isYouTubeHost) return false;
    if (hostname.includes("youtu.be")) {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
      return Boolean(id);
    }
    return Boolean(parsed.searchParams.get("v"));
  } catch {
    return false;
  }
}

function pickCommandJsonPayload(output: string) {
  const normalized = output.replace(/\r/g, "\n");
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      JSON.parse(line);
      return line;
    } catch {
      // keep scanning previous lines
    }
  }
  return "";
}

async function downloadYouTubeAsset(job: Job) {
  if (!job.youtubeUrl) {
    throw new Error("YouTube URL is missing for this job");
  }
  const downloadScript = path.join(rootDir, "apps", "server", "scripts", "ytdlp_download.py");
  const maxHeight = job.maxHeight ?? 1080;
  const raw = await runCommandCapture("python", [downloadScript, job.youtubeUrl, job.assetPath, String(maxHeight)]);
  const payload = pickCommandJsonPayload(raw);
  if (!payload) {
    throw new Error("yt-dlp returned empty output");
  }

  let parsed: { asset_path?: string; title?: string; ext?: string };
  try {
    parsed = JSON.parse(payload) as { asset_path?: string; title?: string; ext?: string };
  } catch {
    throw new Error(`Unable to parse yt-dlp output: ${payload}`);
  }

  if (!parsed.asset_path) {
    throw new Error("yt-dlp did not return downloaded file path");
  }

  const nextAssetPath = parsed.asset_path;
  const nextExt = parsed.ext || path.extname(nextAssetPath) || ".mp4";
  const nextBasename = sanitizeBasename(parsed.title || "youtube-video");
  const nextOriginalFilename = `${nextBasename}${nextExt}`;
  updateJob(job, {
    assetPath: nextAssetPath,
    basename: nextBasename,
    originalFilename: nextOriginalFilename
  });
}

async function probeYouTubeUrl(youtubeUrl: string) {
  const downloadScript = path.join(rootDir, "apps", "server", "scripts", "ytdlp_download.py");
  await runCommandCapture("python", [downloadScript, "--probe", youtubeUrl]);
}

async function runAsrWithProgress(
  job: Job,
  scriptPath: string,
  audioPath: string,
  outputSrt: string,
  durationSec: number
) {
  return new Promise<void>((resolve, reject) => {
    const args = [scriptPath, audioPath, outputSrt, WHISPER_MODEL, String(durationSec)];
    const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";
    let lastRatio = 0;
    let lastLog = Date.now();

    child.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("PROGRESS ")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 5) continue;
        const ratio = Number.parseFloat(parts[1]);
        const processed = Number.parseFloat(parts[2]);
        const total = Number.parseFloat(parts[3]);
        const speed = Number.parseFloat(parts[4]);
        if (!Number.isFinite(ratio)) continue;
        const progress = Math.min(70, Math.max(40, Math.round(40 + ratio * 30)));
        updateJob(job, {
          progress,
          asrProcessedSec: Number.isFinite(processed) ? processed : undefined,
          asrTotalSec: Number.isFinite(total) ? total : durationSec,
          asrSpeed: Number.isFinite(speed) ? speed : undefined
        });
        const now = Date.now();
        if (ratio - lastRatio >= 0.05 || now - lastLog >= 5000) {
          if (Number.isFinite(processed) && Number.isFinite(total) && Number.isFinite(speed)) {
            console.log(
              `[${job.id}] ASR ${processed.toFixed(1)} / ${total.toFixed(1)} sec (${speed.toFixed(2)}x)`
            );
          }
          lastRatio = ratio;
          lastLog = now;
        }
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`python exited with code ${code}: ${stderr}`));
    });
  });
}

async function processQueue() {
  if (isProcessing) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job) return;

  isProcessing = true;
  activeJobId = nextId;
  try {
    await runJob(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    closeOpenStepOnError(job);
    updateJob(job, { state: "error", error: message });
  } finally {
    isProcessing = false;
    activeJobId = null;
    processQueue();
  }
}

async function runJob(job: Job) {
  let current = jobs.get(job.id) ?? job;
  if (current.state === "done") return;
  if (current.source === "youtube" && !current.downloadCompleted) {
    updateJob(job, { state: "processing", step: "download", progress: 5 });
    markStepStart(job.id, "download", false);
    await downloadYouTubeAsset(job);
    markStepEnd(job.id, "download");
    current = jobs.get(job.id) ?? job;
    updateJob(current, { downloadCompleted: true, state: "ready", progress: 100 });
    current = jobs.get(job.id) ?? current;
  }

  if (!current.processRequested) {
    if (current.state !== "ready") {
      updateJob(current, {
        state: "ready",
        step: current.downloadCompleted ? current.step : "download",
        progress: current.downloadCompleted ? Math.max(current.progress, 5) : current.progress
      });
    }
    return;
  }

  updateJob(current, {
    state: "processing",
    step: "extract",
    progress: current.source === "youtube" ? 20 : 10
  });
  markStepStart(job.id, "extract", true);
  current = jobs.get(job.id) ?? current;
  const jobFolder = path.dirname(current.assetPath);
  const audioPath = path.join(jobFolder, "audio.wav");
  await runCommand("ffmpeg", ["-y", "-i", current.assetPath, "-vn", "-ac", "1", "-ar", "16000", audioPath]);
  markStepEnd(job.id, "extract");

  const audioDuration = await getMediaDurationSeconds(audioPath);
  updateJob(current, { step: "asr", progress: 40, asrTotalSec: audioDuration });
  markStepStart(job.id, "asr");
  const asrScript = path.join(rootDir, "apps", "server", "scripts", "asr.py");
  await runAsrWithProgress(current, asrScript, audioPath, current.enSrtPath, audioDuration);
  markStepEnd(job.id, "asr");

  current = jobs.get(job.id) ?? current;
  updateJob(current, { step: "translate", progress: 70 });
  markStepStart(job.id, "translate");
  const translateScript = path.join(rootDir, "apps", "server", "scripts", "translate.py");
  await runCommand("python", [translateScript, current.enSrtPath, current.ruSrtPath]);
  markStepEnd(job.id, "translate");

  current = jobs.get(job.id) ?? current;
  updateJob(current, { step: "convert", progress: 90 });
  markStepStart(job.id, "convert");
  const enSrt = await fs.readFile(current.enSrtPath, "utf-8");
  const ruSrt = await fs.readFile(current.ruSrtPath, "utf-8");
  await fs.writeFile(current.enVttPath, srtToVtt(enSrt), "utf-8");
  await fs.writeFile(current.ruVttPath, srtToVtt(ruSrt), "utf-8");
  markStepEnd(job.id, "convert");

  finalizeProcessing(job.id);
  current = jobs.get(job.id) ?? current;
  updateJob(current, { state: "done", progress: 100 });
}

app.post("/api/jobs", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "file required" });
  }

  const id = uuidv4();
  const originalFilename = req.file.originalname || "video.mp4";
  const ext = path.extname(originalFilename) || ".mp4";
  const rawBasename = path.basename(originalFilename, ext) || "video";
  const basename = sanitizeBasename(rawBasename);
  const jobFolder = path.join(jobsDir, id);
  await fs.mkdir(jobFolder, { recursive: true });

  const assetPath = path.join(jobFolder, `video${ext}`);
  await fs.rename(req.file.path, assetPath);

  const job: Job = {
    id,
    state: "ready",
    step: "upload",
    progress: 5,
    originalFilename,
    basename,
    assetPath,
    enSrtPath: path.join(jobFolder, "en.srt"),
    ruSrtPath: path.join(jobFolder, "ru.srt"),
    enVttPath: path.join(jobFolder, "en.vtt"),
    ruVttPath: path.join(jobFolder, "ru.vtt"),
    source: "upload",
    downloadCompleted: true,
    processRequested: false,
    createdAt: Date.now()
  };

  jobs.set(id, job);

  return res.json({ jobId: id });
});

app.post("/api/jobs/youtube", async (req, res) => {
  const { url, maxHeight } = req.body as { url?: string; maxHeight?: number };
  const youtubeUrl = url?.trim() ?? "";
  if (!youtubeUrl || !isYouTubeUrl(youtubeUrl)) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }
  try {
    await probeYouTubeUrl(youtubeUrl);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const normalizedHeight = Number.isFinite(maxHeight) ? Math.max(144, Math.round(Number(maxHeight))) : 1080;
  const id = uuidv4();
  const basename = sanitizeBasename("youtube-video");
  const jobFolder = path.join(jobsDir, id);
  await fs.mkdir(jobFolder, { recursive: true });

  const assetPath = path.join(jobFolder, "video.mp4");
  const job: Job = {
    id,
    state: "queued",
    step: "download",
    progress: 0,
    originalFilename: `${basename}.mp4`,
    basename,
    assetPath,
    enSrtPath: path.join(jobFolder, "en.srt"),
    ruSrtPath: path.join(jobFolder, "ru.srt"),
    enVttPath: path.join(jobFolder, "en.vtt"),
    ruVttPath: path.join(jobFolder, "ru.vtt"),
    source: "youtube",
    youtubeUrl,
    maxHeight: normalizedHeight,
    downloadCompleted: false,
    processRequested: false,
    createdAt: Date.now()
  };

  jobs.set(id, job);
  enqueueJob(id);

  return res.json({ jobId: id });
});

app.post("/api/jobs/:id/start", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.state === "done") {
    return res.json({ jobId: job.id, state: job.state });
  }
  if (job.state === "error") {
    return res.status(409).json({ error: "job is in error state" });
  }

  const next = updateJob(job, {
    processRequested: true,
    state: job.state === "ready" ? "queued" : job.state
  });
  enqueueJob(next.id);
  return res.json({ jobId: next.id, state: next.state });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const now = Date.now();
  const elapsedMs = job.processingStartedAt
    ? (job.processingFinishedAt ?? now) - job.processingStartedAt
    : null;
  const totalDurationMs =
    job.processingStartedAt && job.processingFinishedAt
      ? job.processingFinishedAt - job.processingStartedAt
      : null;
  return res.json({
    jobId: job.id,
    state: job.state,
    step: job.step,
    progress: job.progress,
    error: job.error ?? null,
    asrProcessedSec: job.asrProcessedSec ?? null,
    asrTotalSec: job.asrTotalSec ?? null,
    asrSpeed: job.asrSpeed ?? null,
    processingStartedAt: job.processingStartedAt ?? null,
    processingFinishedAt: job.processingFinishedAt ?? null,
    elapsedMs,
    totalDurationMs,
    stepDurationsMs: buildStepDurations(job)
  });
});

app.get("/api/jobs/:id/asset", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  try {
    await fs.access(job.assetPath);
  } catch {
    return res.status(404).json({ error: "asset not ready" });
  }
  if (req.query.download === "1") {
    const ext = path.extname(job.assetPath) || ".mp4";
    return res.download(job.assetPath, `${job.basename}${ext}`);
  }
  return res.sendFile(job.assetPath);
});

app.get("/api/jobs/:id/subs/en", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  return res.sendFile(job.enVttPath);
});

app.get("/api/jobs/:id/subs/ru", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  return res.sendFile(job.ruVttPath);
});

app.get("/api/jobs/:id/subs/en.srt", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  return res.download(job.enSrtPath, `${job.basename}.en.srt`);
});

app.get("/api/jobs/:id/subs/ru.srt", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  return res.download(job.ruSrtPath, `${job.basename}.ru.srt`);
});

app.get("/api/jobs/:id/subs/en.vtt", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  return res.download(job.enVttPath, `${job.basename}.en.vtt`);
});

app.get("/api/jobs/:id/subs/ru.vtt", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  return res.download(job.ruVttPath, `${job.basename}.ru.vtt`);
});

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

function buildHeaders(apiKey?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

app.post("/api/llm/models", async (req, res) => {
  const { baseUrl, apiKey } = req.body as { baseUrl?: string; apiKey?: string };
  if (!baseUrl) {
    return res.status(400).json({ error: "baseUrl required" });
  }
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(apiKey)
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: text || "Provider error" });
    }
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    const models = data.data?.map((item) => ({ id: item.id })) ?? [];
    return res.json({ models });
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/llm/chat", async (req, res) => {
  const { baseUrl, apiKey, model, messages } = req.body as {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    messages?: Array<{ role: string; content: string }>;
  };
  if (!baseUrl || !model || !messages) {
    return res.status(400).json({ error: "baseUrl, model, messages required" });
  }
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({ model, messages })
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: text || "Provider error" });
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const message = data.choices?.[0]?.message?.content ?? "";
    return res.json({ message });
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const webDist = path.join(rootDir, "apps", "web", "dist");
app.use(express.static(webDist));
app.get("*", async (_req, res, next) => {
  try {
    const indexPath = path.join(webDist, "index.html");
    await fs.access(indexPath);
    return res.sendFile(indexPath);
  } catch {
    return next();
  }
});

async function bootstrap() {
  await ensureDirs();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});

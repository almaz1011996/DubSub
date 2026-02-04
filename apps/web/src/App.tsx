import { useEffect, useRef, useState } from "react";

const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (window.location.port === "5173" ? "http://localhost:3001" : "");

type JobStatus = {
  jobId: string;
  state: "queued" | "processing" | "done" | "error";
  step: "upload" | "extract" | "asr" | "translate" | "convert";
  progress: number;
  error: string | null;
  asrProcessedSec: number | null;
  asrTotalSec: number | null;
  asrSpeed: number | null;
};

function formatSeconds(value: number | null) {
  if (!value || !Number.isFinite(value)) return "-";
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function srtToVttClient(srtText: string) {
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

function useTextTrack(trackRef: React.RefObject<HTMLTrackElement>, src: string) {
  const [text, setText] = useState("");

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    if (!src) {
      setText("");
      return;
    }
    const track = el.track;
    track.mode = "hidden";

    const handler = () => {
      const cues = track.activeCues;
      if (!cues || cues.length === 0) {
        setText("");
        return;
      }
      const cue = cues[0] as VTTCue;
      setText(cue.text ?? "");
    };

    track.addEventListener("cuechange", handler);
    return () => track.removeEventListener("cuechange", handler);
  }, [trackRef, src]);

  return text;
}

function Player({
  videoUrl,
  enVttUrl,
  ruVttUrl,
  showEn,
  showRu,
  videoRef,
  onTimeUpdate,
  seekTo
}: {
  videoUrl: string;
  enVttUrl: string;
  ruVttUrl: string;
  showEn: boolean;
  showRu: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  onTimeUpdate?: (time: number) => void;
  seekTo?: number | null;
}) {
  const enTrackRef = useRef<HTMLTrackElement>(null);
  const ruTrackRef = useRef<HTMLTrackElement>(null);

  const enText = useTextTrack(enTrackRef, enVttUrl);
  const ruText = useTextTrack(ruTrackRef, ruVttUrl);

  useEffect(() => {
    if (seekTo == null) return;
    const video = videoRef.current;
    if (!video) return;
    if (Number.isNaN(seekTo)) return;

    const applySeek = () => {
      try {
        video.currentTime = seekTo;
      } catch {
        return;
      }
    };

    if (video.readyState >= 1) {
      applySeek();
      return;
    }

    video.addEventListener("loadedmetadata", applySeek, { once: true });
    return () => video.removeEventListener("loadedmetadata", applySeek);
  }, [seekTo, videoRef, videoUrl]);

  return (
    <div className="player">
      <video
        ref={videoRef}
        controls
        className="video"
        crossOrigin="anonymous"
        onTimeUpdate={(e) => onTimeUpdate?.((e.target as HTMLVideoElement).currentTime)}
      >
        <source src={videoUrl} />
        <track ref={enTrackRef} kind="subtitles" srcLang="en" src={enVttUrl} />
        <track ref={ruTrackRef} kind="subtitles" srcLang="ru" src={ruVttUrl} />
      </video>
      <div className="subtitle-layer" aria-live="off">
        {showEn && enText && <div className="subtitle en">{enText}</div>}
        {showRu && ruText && <div className="subtitle ru">{ruText}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEn, setShowEn] = useState(true);
  const [showRu, setShowRu] = useState(true);
  const [playerMode, setPlayerMode] = useState<"processed" | "local">("local");
  const [processedTime, setProcessedTime] = useState(0);
  const [localTime, setLocalTime] = useState(0);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastModeRef = useRef<"processed" | "local" | null>(null);
  const [localVideo, setLocalVideo] = useState<File | null>(null);
  const [localEnSub, setLocalEnSub] = useState<File | null>(null);
  const [localRuSub, setLocalRuSub] = useState<File | null>(null);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [localEnUrl, setLocalEnUrl] = useState<string | null>(null);
  const [localRuUrl, setLocalRuUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;

    let isActive = true;
    const fetchStatus = async () => {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}`);
      if (!res.ok) {
        throw new Error("Failed to fetch status");
      }
      const data = (await res.json()) as JobStatus;
      if (isActive) setStatus(data);
    };

    fetchStatus().catch((err) => setError(String(err)));
    const timer = setInterval(() => {
      fetchStatus().catch((err) => setError(String(err)));
    }, 2000);

    return () => {
      isActive = false;
      clearInterval(timer);
    };
  }, [jobId]);

  const handleUpload = async () => {
    if (!file) return;
    setError(null);
    setStatus(null);
    setJobId(null);

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${API_BASE}/api/jobs`, {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Upload failed");
    }

    const data = await res.json();
    setJobId(data.jobId);
  };

  const done = status?.state === "done";
  const hasError = status?.state === "error";
  const hasLocalPlayer = Boolean(localVideoUrl && (localEnUrl || localRuUrl));

  useEffect(() => {
    if (done) {
      setPlayerMode("processed");
      return;
    }
    if (localVideoUrl) {
      setPlayerMode("local");
    }
  }, [done, localVideoUrl]);

  useEffect(() => {
    if (lastModeRef.current === playerMode) return;
    lastModeRef.current = playerMode;
    if (playerMode === "processed") {
      setSeekTarget(processedTime);
    } else {
      setSeekTarget(localTime);
    }
  }, [playerMode]);

  useEffect(() => {
    if (!localVideo) {
      setLocalVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(localVideo);
    setLocalVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [localVideo]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    const load = async () => {
      if (!localEnSub) {
        setLocalEnUrl(null);
        return;
      }
      const name = localEnSub.name.toLowerCase();
      if (name.endsWith(".vtt")) {
        objectUrl = URL.createObjectURL(localEnSub);
        if (active) setLocalEnUrl(objectUrl);
        return;
      }
      const text = await localEnSub.text();
      const vtt = srtToVttClient(text);
      const blob = new Blob([vtt], { type: "text/vtt" });
      objectUrl = URL.createObjectURL(blob);
      if (active) setLocalEnUrl(objectUrl);
    };

    load().catch(() => setLocalEnUrl(null));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [localEnSub]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    const load = async () => {
      if (!localRuSub) {
        setLocalRuUrl(null);
        return;
      }
      const name = localRuSub.name.toLowerCase();
      if (name.endsWith(".vtt")) {
        objectUrl = URL.createObjectURL(localRuSub);
        if (active) setLocalRuUrl(objectUrl);
        return;
      }
      const text = await localRuSub.text();
      const vtt = srtToVttClient(text);
      const blob = new Blob([vtt], { type: "text/vtt" });
      objectUrl = URL.createObjectURL(blob);
      if (active) setLocalRuUrl(objectUrl);
    };

    load().catch(() => setLocalRuUrl(null));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [localRuSub]);

  return (
    <div className="page">
      <header className="header">
        <h1>DubSub</h1>
        <p>Local EN + RU subtitle generator with dual display.</p>
      </header>

      <section className="card">
        <div className="upload">
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button onClick={() => handleUpload().catch((err) => setError(String(err)))} disabled={!file}>
            Upload & Process
          </button>
        </div>

        {status && (
          <div className="status">
            <div>
              Status: <strong>{status.state}</strong>
            </div>
            <div>
              Step: <strong>{status.step}</strong>
            </div>
            <div>Progress: {status.progress}%</div>
            {status.step === "asr" && (
              <div>
                ASR: {formatSeconds(status.asrProcessedSec)} / {formatSeconds(status.asrTotalSec)}{" "}
                {status.asrSpeed ? `(${status.asrSpeed.toFixed(2)}x)` : ""}
              </div>
            )}
            {status.error && <div className="error">{status.error}</div>}
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </section>

      <section className="card">
        <div className="section-title">Player</div>
        <div className="tabs">
          <button
            className={`tab ${playerMode === "processed" ? "active" : ""}`}
            onClick={() => setPlayerMode("processed")}
            disabled={!done || !jobId}
            type="button"
          >
            Processed
          </button>
          <button
            className={`tab ${playerMode === "local" ? "active" : ""}`}
            onClick={() => setPlayerMode("local")}
            type="button"
          >
            Local
          </button>
        </div>
        <div className="toggles">
          <label>
            <input type="checkbox" checked={showEn} onChange={(e) => setShowEn(e.target.checked)} /> EN
          </label>
          <label>
            <input type="checkbox" checked={showRu} onChange={(e) => setShowRu(e.target.checked)} /> RU
          </label>
        </div>
        {playerMode === "processed" && done && jobId && (
          <div className="download">
            <span>Download subtitles:</span>
            <a href={`${API_BASE}/api/jobs/${jobId}/subs/en.srt`}>EN SRT</a>
            <a href={`${API_BASE}/api/jobs/${jobId}/subs/ru.srt`}>RU SRT</a>
            <a href={`${API_BASE}/api/jobs/${jobId}/subs/en.vtt`}>EN VTT</a>
            <a href={`${API_BASE}/api/jobs/${jobId}/subs/ru.vtt`}>RU VTT</a>
          </div>
        )}
        {playerMode === "processed" && done && jobId && (
          <Player
            videoUrl={`${API_BASE}/api/jobs/${jobId}/asset`}
            enVttUrl={`${API_BASE}/api/jobs/${jobId}/subs/en`}
            ruVttUrl={`${API_BASE}/api/jobs/${jobId}/subs/ru`}
            showEn={showEn}
            showRu={showRu}
            videoRef={videoRef}
            onTimeUpdate={(time) => setProcessedTime(time)}
            seekTo={seekTarget}
          />
        )}
        {playerMode === "local" && hasLocalPlayer && localVideoUrl && (
          <Player
            videoUrl={localVideoUrl}
            enVttUrl={localEnUrl ?? ""}
            ruVttUrl={localRuUrl ?? ""}
            showEn={showEn}
            showRu={showRu}
            videoRef={videoRef}
            onTimeUpdate={(time) => setLocalTime(time)}
            seekTo={seekTarget}
          />
        )}
        {playerMode === "local" && !localVideoUrl && <div className="hint">Choose a video file to start.</div>}

        <div className="local-upload">
          <label>
            Video
            <input type="file" accept="video/*" onChange={(e) => setLocalVideo(e.target.files?.[0] ?? null)} />
          </label>
          <label>
            EN subtitles (SRT/VTT)
            <input
              type="file"
              accept=".srt,.vtt,text/vtt,text/plain"
              onChange={(e) => setLocalEnSub(e.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            RU subtitles (SRT/VTT)
            <input
              type="file"
              accept=".srt,.vtt,text/vtt,text/plain"
              onChange={(e) => setLocalRuSub(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
      </section>

      {hasError && <div className="error">Processing failed. Check server logs.</div>}
    </div>
  );
}

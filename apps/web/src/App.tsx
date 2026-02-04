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

function useTextTrack(trackRef: React.RefObject<HTMLTrackElement>, src: string) {
  const [text, setText] = useState("");

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
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
  showRu
}: {
  videoUrl: string;
  enVttUrl: string;
  ruVttUrl: string;
  showEn: boolean;
  showRu: boolean;
}) {
  const enTrackRef = useRef<HTMLTrackElement>(null);
  const ruTrackRef = useRef<HTMLTrackElement>(null);

  const enText = useTextTrack(enTrackRef, enVttUrl);
  const ruText = useTextTrack(ruTrackRef, ruVttUrl);

  return (
    <div className="player">
      <video controls className="video" crossOrigin="anonymous">
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

      {done && jobId && (
        <section className="card">
          <div className="toggles">
            <label>
              <input type="checkbox" checked={showEn} onChange={(e) => setShowEn(e.target.checked)} /> EN
            </label>
            <label>
              <input type="checkbox" checked={showRu} onChange={(e) => setShowRu(e.target.checked)} /> RU
            </label>
          </div>
          <Player
            videoUrl={`${API_BASE}/api/jobs/${jobId}/asset`}
            enVttUrl={`${API_BASE}/api/jobs/${jobId}/subs/en`}
            ruVttUrl={`${API_BASE}/api/jobs/${jobId}/subs/ru`}
            showEn={showEn}
            showRu={showRu}
          />
        </section>
      )}

      {hasError && <div className="error">Processing failed. Check server logs.</div>}
    </div>
  );
}

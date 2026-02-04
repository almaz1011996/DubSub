import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (window.location.port === "5173" ? "http://localhost:3001" : "");

type JobStep = "upload" | "extract" | "asr" | "translate" | "convert";

type ProviderProfile = {
  id: string;
  name: string;
  type: "lmstudio" | "custom";
  baseUrl: string;
  apiKey?: string;
  model: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

type ExplainRequest = {
  word: string;
  sentence: string;
  timestampSec?: number | null;
  source: "processed" | "local";
};

type JobStatus = {
  jobId: string;
  state: "queued" | "processing" | "done" | "error";
  step: JobStep;
  progress: number;
  error: string | null;
  asrProcessedSec: number | null;
  asrTotalSec: number | null;
  asrSpeed: number | null;
  processingStartedAt: number | null;
  processingFinishedAt: number | null;
  elapsedMs: number | null;
  totalDurationMs: number | null;
  stepDurationsMs: Partial<Record<JobStep, number | null>> | null;
};

const PROFILES_KEY = "dubsub_profiles";
const ACTIVE_PROFILE_KEY = "dubsub_active_profile";

function newId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

function loadProfiles(): ProviderProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProviderProfile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadActiveProfileId(profiles: ProviderProfile[]) {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
    if (raw && profiles.some((p) => p.id === raw)) return raw;
  } catch {
    // ignore
  }
  return profiles[0]?.id ?? null;
}

function saveProfiles(profiles: ProviderProfile[]) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore
  }
}

function saveActiveProfileId(id: string | null) {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_PROFILE_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  } catch {
    // ignore
  }
}

function tokenizeEnglish(text: string) {
  return text.match(/[A-Za-z']+|[^A-Za-z']+/g) ?? [];
}

function formatSeconds(value: number | null) {
  if (!value || !Number.isFinite(value)) return "-";
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDurationMs(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  const totalSec = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
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
  seekTo,
  explainMeta,
  onExplain
}: {
  videoUrl: string;
  enVttUrl: string;
  ruVttUrl: string;
  showEn: boolean;
  showRu: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  onTimeUpdate?: (time: number) => void;
  seekTo?: number | null;
  explainMeta?: Pick<ExplainRequest, "timestampSec" | "source">;
  onExplain?: (request: ExplainRequest) => void;
}) {
  const enTrackRef = useRef<HTMLTrackElement>(null);
  const ruTrackRef = useRef<HTMLTrackElement>(null);
  const subtitleLayerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    word: string;
    sentence: string;
    x: number;
    y: number;
  } | null>(null);

  const enText = useTextTrack(enTrackRef, enVttUrl);
  const ruText = useTextTrack(ruTrackRef, ruVttUrl);
  const cleanSentence = enText.replace(/\s+/g, " ").trim();

  useEffect(() => {
    setSelection(null);
  }, [enText, showEn]);

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

  const handleWordClick = (word: string, event: React.MouseEvent<HTMLButtonElement>) => {
    if (!subtitleLayerRef.current) return;
    const rect = subtitleLayerRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.width - 8, event.clientX - rect.left));
    const y = Math.max(8, Math.min(rect.height - 8, event.clientY - rect.top));
    setSelection({ word, sentence: cleanSentence, x, y });
  };

  const handleExplain = () => {
    if (!selection || !onExplain) return;
    onExplain({
      word: selection.word,
      sentence: selection.sentence,
      timestampSec: explainMeta?.timestampSec ?? null,
      source: explainMeta?.source ?? "processed"
    });
    setSelection(null);
  };

  const renderEnglishSubtitle = () => {
    if (!showEn || !enText) return null;
    const tokens = tokenizeEnglish(enText);
    return (
      <div className="subtitle en" aria-label="English subtitles">
        {tokens.map((token, index) => {
          if (/^[A-Za-z']+$/.test(token)) {
            return (
              <button
                key={`${token}-${index}`}
                type="button"
                className="subtitle-word"
                onClick={(event) => handleWordClick(token, event)}
              >
                {token}
              </button>
            );
          }
          return (
            <span key={`t-${index}`} className="subtitle-text">
              {token}
            </span>
          );
        })}
      </div>
    );
  };

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
      <div className="subtitle-layer" aria-live="off" ref={subtitleLayerRef}>
        {renderEnglishSubtitle()}
        {showRu && ruText && <div className="subtitle ru">{ruText}</div>}
        {selection && (
          <button
            type="button"
            className="explain-button"
            style={{ left: selection.x, top: Math.max(6, selection.y - 36) }}
            onClick={handleExplain}
          >
            Объяснить
          </button>
        )}
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
  const [nowMs, setNowMs] = useState(Date.now());
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() => loadProfiles());
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    loadActiveProfileId(loadProfiles())
  );
  const [profileDraft, setProfileDraft] = useState<ProviderProfile | null>(null);
  const [profileModels, setProfileModels] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [showChat, setShowChat] = useState(true);

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
  const elapsedMs =
    status?.processingStartedAt != null
      ? (status.processingFinishedAt ?? nowMs) - status.processingStartedAt
      : status?.elapsedMs ?? null;
  const stepDurations = status?.stepDurationsMs ?? null;

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

  useEffect(() => {
    if (status?.state !== "processing") return;
    const timer = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, [status?.state]);

  useEffect(() => {
    saveProfiles(profiles);
  }, [profiles]);

  useEffect(() => {
    saveActiveProfileId(activeProfileId);
  }, [activeProfileId]);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;

  useEffect(() => {
    if (!activeProfileId && profiles.length > 0) {
      setActiveProfileId(profiles[0].id);
    }
  }, [activeProfileId, profiles]);

  const startNewProfile = () => {
    setProfileModels([]);
    setProfileDraft({
      id: newId(),
      name: "LM Studio",
      type: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
      model: ""
    });
  };

  const startEditProfile = () => {
    if (!activeProfile) return;
    setProfileModels([]);
    setProfileDraft({ ...activeProfile });
  };

  const saveProfile = () => {
    if (!profileDraft) return;
    const trimmedName = profileDraft.name.trim() || "Профиль";
    const trimmedModel = profileDraft.model.trim();
    const trimmedUrl = profileDraft.baseUrl.trim();
    const nextProfile: ProviderProfile = {
      ...profileDraft,
      name: trimmedName,
      model: trimmedModel,
      baseUrl: trimmedUrl
    };

    setProfiles((current) => {
      const exists = current.some((profile) => profile.id === nextProfile.id);
      if (exists) {
        return current.map((profile) => (profile.id === nextProfile.id ? nextProfile : profile));
      }
      return [...current, nextProfile];
    });
    setActiveProfileId(nextProfile.id);
    setProfileDraft(null);
  };

  const removeProfile = () => {
    if (!activeProfile) return;
    setProfiles((current) => current.filter((profile) => profile.id !== activeProfile.id));
    setActiveProfileId((current) => (current === activeProfile.id ? null : current));
  };

  const fetchModels = async (profile: ProviderProfile) => {
    setProfileModels([]);
    const res = await fetch(`${API_BASE}/api/llm/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: profile.baseUrl, apiKey: profile.apiKey || undefined })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Не удалось загрузить модели.");
    }
    const data = (await res.json()) as { models?: Array<{ id: string }> };
    const models = data.models?.map((item) => item.id).filter(Boolean) ?? [];
    setProfileModels(models);
    if (models.length > 0 && profileDraft && !profileDraft.model) {
      setProfileDraft({ ...profileDraft, model: models[0] });
    }
  };

  const sendChatMessage = async (content: string, resetChat: boolean) => {
    if (!activeProfile || !activeProfile.model) {
      setChatMessages((current) => [
        ...current,
        {
          id: newId(),
          role: "assistant",
          content: "Выберите профиль и модель перед объяснением слова."
        }
      ]);
      return;
    }

    const userMessage: ChatMessage = { id: newId(), role: "user", content };
    const history = resetChat ? [] : chatMessages;
    if (resetChat) {
      setChatMessages([userMessage]);
    } else {
      setChatMessages((current) => [...current, userMessage]);
    }
    setChatLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: activeProfile.baseUrl,
          apiKey: activeProfile.apiKey || undefined,
          model: activeProfile.model,
          messages: [
            {
              role: "system",
              content: "Ты помогаешь изучать английский. Отвечай кратко и структурированно. Не используй таблицы"
            },
            ...history.map((message) => ({
              role: message.role,
              content: message.content
            })),
            { role: "user", content }
          ]
        })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Ошибка ответа провайдера.");
      }
      const data = (await res.json()) as { message?: string };
      const message = data.message?.trim() || "Ответ пуст.";
      setChatMessages((current) => [
        ...current,
        { id: newId(), role: "assistant", content: message }
      ]);
    } catch (err) {
      setChatMessages((current) => [
        ...current,
        {
          id: newId(),
          role: "assistant",
          content: `Не удалось получить ответ: ${err instanceof Error ? err.message : String(err)}`
        }
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const sendExplainRequest = async (request: ExplainRequest) => {
    setShowChat(true);
    const userPrompt = `Объясни слово "${request.word}".\nДай:\n1) Перевод на русский\n2) Краткое значение\n3) Как это использовано в предложении: "${request.sentence}"`;
    await sendChatMessage(userPrompt, true);
  };

  const handleSendChatInput = async () => {
    const value = chatInput.trim();
    if (!value) return;
    setChatInput("");
    await sendChatMessage(value, false);
  };

  return (
    <div className={`page ${showChat ? "" : "chat-hidden"}`}>
      <div className="main">
        <header className="header">
          <div>
            <h1>DubSub</h1>
            <p>Local EN + RU subtitle generator with dual display.</p>
          </div>
          <div className="header-actions">
            <button type="button" onClick={() => setShowChat((current) => !current)}>
              {showChat ? "Скрыть чат" : "Показать чат"}
            </button>
          </div>
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
              {(status.state === "processing" || status.state === "done") && (
                <div>Elapsed: {formatDurationMs(elapsedMs)}</div>
              )}
              {status.step === "asr" && (
                <div>
                  {status.asrProcessedSec == null ? (
                    <>
                      <div>ASR: initializing model...</div>
                      <div className="status-note">First run may take a few minutes.</div>
                    </>
                  ) : (
                    <>
                      ASR: {formatSeconds(status.asrProcessedSec)} / {formatSeconds(status.asrTotalSec)}{" "}
                      {status.asrSpeed ? `(${status.asrSpeed.toFixed(2)}x)` : ""}
                    </>
                  )}
                </div>
              )}
              {done && stepDurations && (
                <div className="timings">
                  <div>Step timings:</div>
                  <div>Extract: {formatDurationMs(stepDurations.extract ?? null)}</div>
                  <div>ASR: {formatDurationMs(stepDurations.asr ?? null)}</div>
                  <div>Translate: {formatDurationMs(stepDurations.translate ?? null)}</div>
                  <div>Convert: {formatDurationMs(stepDurations.convert ?? null)}</div>
                  <div>Total: {formatDurationMs(status.totalDurationMs ?? elapsedMs)}</div>
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
              explainMeta={{ source: "processed", timestampSec: processedTime }}
              onExplain={sendExplainRequest}
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
              explainMeta={{ source: "local", timestampSec: localTime }}
              onExplain={sendExplainRequest}
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

      {showChat && (
        <aside className="sidebar">
        <section className="card chat-panel">
          <div className="section-title">AI чат</div>
          <div className="profile-header">
            <label className="profile-label">
              Профиль
              <select
                value={activeProfileId ?? ""}
                onChange={(e) => setActiveProfileId(e.target.value || null)}
                disabled={profiles.length === 0}
              >
                {profiles.length === 0 && <option value="">Нет профилей</option>}
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="profile-actions">
              <button type="button" onClick={startNewProfile}>
                + Добавить
              </button>
              <button type="button" onClick={startEditProfile} disabled={!activeProfile}>
                Редактировать
              </button>
              <button type="button" onClick={removeProfile} disabled={!activeProfile}>
                Удалить
              </button>
            </div>
          </div>

          {profileDraft && (
            <div className="profile-form">
              <label>
                Название
                <input
                  type="text"
                  value={profileDraft.name}
                  onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })}
                />
              </label>
              <label>
                Тип
                <select
                  value={profileDraft.type}
                  onChange={(e) => {
                    const type = e.target.value as ProviderProfile["type"];
                    const baseUrl =
                      type === "lmstudio" && !profileDraft.baseUrl
                        ? "http://localhost:1234/v1"
                        : profileDraft.baseUrl;
                    setProfileDraft({ ...profileDraft, type, baseUrl });
                  }}
                >
                  <option value="lmstudio">LM Studio</option>
                  <option value="custom">URL провайдера</option>
                </select>
              </label>
              <label>
                Base URL
                <input
                  type="text"
                  value={profileDraft.baseUrl}
                  onChange={(e) => setProfileDraft({ ...profileDraft, baseUrl: e.target.value })}
                />
              </label>
              <label>
                API Key (опционально)
                <input
                  type="password"
                  value={profileDraft.apiKey ?? ""}
                  onChange={(e) => setProfileDraft({ ...profileDraft, apiKey: e.target.value })}
                />
              </label>
              <label>
                Модель
                {profileModels.length > 0 ? (
                  <select
                    value={profileDraft.model}
                    onChange={(e) => setProfileDraft({ ...profileDraft, model: e.target.value })}
                  >
                    {profileModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={profileDraft.model}
                    onChange={(e) => setProfileDraft({ ...profileDraft, model: e.target.value })}
                  />
                )}
              </label>
              <div className="profile-actions-row">
                <button
                  type="button"
                  onClick={() => profileDraft && fetchModels(profileDraft).catch((err) => setError(String(err)))}
                >
                  Загрузить модели
                </button>
                <button type="button" onClick={saveProfile}>
                  Сохранить
                </button>
                <button type="button" onClick={() => setProfileDraft(null)}>
                  Отмена
                </button>
              </div>
            </div>
          )}

          <div className="chat-messages">
            {chatMessages.length === 0 && <div className="hint">Кликните на слово, чтобы получить объяснение.</div>}
            {chatMessages.map((message) => (
              <div key={message.id} className={`chat-message ${message.role}`}>
                <div className="chat-role">{message.role === "user" ? "Вы" : "AI"}</div>
                <div className="chat-content">
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
              </div>
            ))}
            {chatLoading && <div className="chat-loading">Думаю...</div>}
          </div>
          <div className="chat-input">
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Уточните ответ или задайте вопрос..."
              rows={3}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSendChatInput().catch(() => undefined);
                }
              }}
            />
            <button type="button" onClick={() => handleSendChatInput().catch(() => undefined)}>
              Отправить
            </button>
          </div>
        </section>
      </aside>
      )}
    </div>
  );
}

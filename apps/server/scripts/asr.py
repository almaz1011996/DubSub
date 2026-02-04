import argparse
import time
from faster_whisper import WhisperModel


def format_time(seconds: float) -> str:
    millis = int(round(seconds * 1000))
    hours = millis // 3600000
    minutes = (millis % 3600000) // 60000
    secs = (millis % 60000) // 1000
    ms = millis % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def write_srt(segments, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n")
            f.write(f"{format_time(seg.start)} --> {format_time(seg.end)}\n")
            f.write(seg.text.strip() + "\n\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_wav")
    parser.add_argument("output_srt")
    parser.add_argument("model", nargs="?", default="small")
    parser.add_argument("duration_sec", nargs="?", type=float, default=0.0)
    args = parser.parse_args()

    model = WhisperModel(args.model, device="auto", compute_type="int8")
    segments_iter, _ = model.transcribe(args.input_wav, language="en", vad_filter=True)

    total = float(args.duration_sec or 0.0)
    start_time = time.time()
    segments = []
    for seg in segments_iter:
        segments.append(seg)
        if total > 0:
            ratio = min(max(seg.end / total, 0.0), 1.0)
            elapsed = max(time.time() - start_time, 0.001)
            speed = seg.end / elapsed
            print(f"PROGRESS {ratio:.4f} {seg.end:.2f} {total:.2f} {speed:.2f}", flush=True)

    write_srt(segments, args.output_srt)


if __name__ == "__main__":
    main()

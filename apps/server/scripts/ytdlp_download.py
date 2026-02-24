import json
import os
import sys

from yt_dlp import YoutubeDL


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == "--probe":
        url = sys.argv[2]
        try:
            with YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    raise RuntimeError("Video unavailable")
                print(json.dumps({"ok": True, "title": info.get("title") or "youtube-video"}))
                return 0
        except Exception as err:
            print(f"yt-dlp failed: {err}", file=sys.stderr)
            return 1

    if len(sys.argv) < 3:
        print("Usage: ytdlp_download.py <url> <output_path> [max_height] or --probe <url>", file=sys.stderr)
        return 2

    url = sys.argv[1]
    output_path = sys.argv[2]
    max_height = 1080
    if len(sys.argv) >= 4:
        try:
            max_height = max(144, int(sys.argv[3]))
        except ValueError:
            max_height = 1080

    out_dir = os.path.dirname(output_path) or "."
    out_name = os.path.basename(output_path)
    out_template = os.path.join(out_dir, f"{os.path.splitext(out_name)[0]}.%(ext)s")

    ydl_opts = {
        "format": f"bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best",
        "merge_output_format": "mp4",
        "outtmpl": out_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": False,
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                raise RuntimeError("Video unavailable")
            final_path = ydl.prepare_filename(info)
            if info.get("requested_downloads"):
                req = info["requested_downloads"][0]
                final_path = req.get("filepath") or req.get("_filename") or final_path
            if info.get("ext"):
                final_path = os.path.splitext(final_path)[0] + f".{info['ext']}"
            if not os.path.exists(final_path):
                base, _ = os.path.splitext(final_path)
                candidate = f"{base}.mp4"
                if os.path.exists(candidate):
                    final_path = candidate
            title = info.get("title") or "youtube-video"
            ext = os.path.splitext(final_path)[1] or ".mp4"
            print(json.dumps({"asset_path": final_path, "title": title, "ext": ext}))
            return 0
    except Exception as err:
        print(f"yt-dlp failed: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

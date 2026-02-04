# DubSub

Local web app that generates English + Russian subtitles and shows both in a browser player.

## Requirements
- Node.js 18+
- Python 3.10+
- ffmpeg in PATH

## Setup

### 1) Create/activate venv (Windows PowerShell)
```
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2) Install Node deps
```
npm install
```

### 3) Install Python deps
```
python -m pip install -r apps/server/scripts/requirements.txt
```

### 4) Install Argos translation model (EN -> RU)
Use the bundled installer script (it pulls from the Argos package index):
```
python apps/server/scripts/install_argos.py
```
or:
```
npm -w apps/server run setup:argos
```

### 5) Run dev servers
```
npm run dev
```

Frontend: http://localhost:5173
Backend: http://localhost:3001

## Usage
1. Open the frontend.
2. Upload an English video.
3. Wait for processing.
4. Toggle EN/RU subtitles in the player.

## Notes
- Subtitles are stored as soft tracks (VTT/SRT), no burn-in.
- Processing runs locally via ffmpeg + Whisper + Argos Translate.

## Troubleshooting
- If the model install appears to do nothing, run:
  - `python apps/server/scripts/install_argos.py`
- To verify Argos is installed:
  - `python -c "import argostranslate.translate as t; print([l.code for l in t.get_installed_languages()])"`

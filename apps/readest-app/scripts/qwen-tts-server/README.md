# Readest + Qwen3-TTS server

This adapter lets Readest use Qwen3-TTS as a remote voice provider while
reusing its existing audio cache and chapter-download workflow. The model is
not bundled in the Android app; it runs on a PC/server and sends WAV audio to
Readest.

## 1. Start the service

Use Python 3.10+ and install a PyTorch build appropriate for your GPU first.
Then install `requirements.txt` and run:

```bash
python -m pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

The first startup downloads/loads `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` and
can take a while. A GPU is strongly recommended; CPU inference may be very
slow and memory-intensive. Check `http://127.0.0.1:8000/health`.

## 2. Point Readest at the service

The provider defaults to `http://127.0.0.1:8000`. On Android, `127.0.0.1`
means the phone itself, not your PC. Set the provider URL to the PC's LAN IP
(e.g. `http://192.168.1.50:8000`) using the exported
`setQwenTTSBaseUrl(url)` helper / app integration. The helper stores the value
in local storage under `qwenTTSBaseUrl`.

For a temporary developer-console setup, import/call the helper from the app's
runtime where module imports are available, or set
`localStorage.setItem('qwenTTSBaseUrl', 'http://192.168.1.50:8000')` and reload.
The app must be able to reach the host/port; firewall rules and browser CORS
policy may need configuration for web builds. Do not expose this unauthenticated
development server directly to the public Internet.

## Notes / current limitations

- The adapter returns WAV without word-level timestamps, so Readest uses its
  normal sentence-level highlighting fallback.
- The CustomVoice model's speaker catalog is surfaced as selectable voices;
  actual voice quality and supported speaker/language combinations should be
  checked against the installed Qwen version.
- Language-aware instructions help but do not guarantee perfect per-word
  language identification. A future pronunciation layer should use a book
  language detector, context-sensitive lexicon, and user correction memory.
- Chapter audio is cached by Readest, so downloaded segments can be replayed
  offline. New uncached sentences still require the server.

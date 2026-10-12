# Implementation notes

Readest-side files added:
- `src/services/tts/providers/qwen.ts`: remote provider, French narrator prompt, health check, WAV response handling.
- `src/services/tts/QwenTTSClient.ts`: adapter into the existing buffered playback and persistent per-book cache.
- `src/components/settings/QwenTTSSection.tsx`: server URL setting.
- `src/__tests__/services/qwen-tts-provider.test.ts`: provider contract tests.

Existing integration points changed:
- `src/services/tts/TTSController.ts`: initialize, expose and select Qwen voices; set language and shut down cleanly.
- `src/components/settings/TTSPanel.tsx`: show Qwen server settings.
- `src/services/tts/index.ts`: export the client/provider helpers.

The server implementation is a first working adapter, not an embedded Android model. The pronunciation prompt is a best-effort hint, not a guarantee of perfect word-by-word language disambiguation. Sentence-level highlighting is used because this endpoint does not return word timings.

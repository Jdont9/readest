// Split out of TTSController.ts so BufferedTTSClient.ts (which every engine
// subclasses) can use this value without creating a runtime import cycle
// back into TTSController.ts — TTSController.ts re-exports it below so
// existing `from './TTSController'` imports elsewhere keep working
// unchanged.

// Applies to the paragraph-to-paragraph transition (stop -> next -> speak),
// which is engine-agnostic and handled entirely in
// BufferedTTSClient#speak()/forward(). Unlike the Edge-only inter-sentence
// gap, this applies to every TTS client. There is no natural pause here
// otherwise — the transition is as fast as the async stop/init overhead
// allows, which reads as no pause at all.
export const DEFAULT_PARAGRAPH_GAP_SEC = 0.3;

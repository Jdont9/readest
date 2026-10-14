// Qwen3-TTS remote provider. The neural model runs in a separate Python
// service; this adapter deliberately reuses Readest's existing buffered
// playback, chapter downloader and persistent cache pipeline.
import type { TTSVoice } from '../types';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

export const QWEN_TTS_BASE_URL_KEY = 'qwenTTSBaseUrl';
export const DEFAULT_QWEN_TTS_BASE_URL = 'http://127.0.0.1:8000';

export const QWEN_TTS_CONCURRENCY_KEY = 'qwenTTSDownloadConcurrency';
const DEFAULT_QWEN_DOWNLOAD_CONCURRENCY = 6;
const MAX_QWEN_DOWNLOAD_CONCURRENCY = 10;
// Batch size the server advertised on /health (null until probed).
let serverMaxBatch: number | null = null;

/**
 * How many sentences a chapter download sends at once. Defaults to the batch
 * size the server announces (so the GPU gets full batches), unless the user
 * overrode it in localStorage under `qwenTTSDownloadConcurrency`.
 */
export function getQwenDownloadConcurrency(): number {
  let configured = 0;
  try {
    configured = Number(globalThis.localStorage?.getItem(QWEN_TTS_CONCURRENCY_KEY));
  } catch {
    // Storage unavailable: fall through to the server/default value.
  }
  const value =
    Number.isFinite(configured) && configured >= 1
      ? configured
      : (serverMaxBatch ?? DEFAULT_QWEN_DOWNLOAD_CONCURRENCY);
  return Math.min(MAX_QWEN_DOWNLOAD_CONCURRENCY, Math.max(1, Math.floor(value)));
}

export function getQwenTTSBaseUrl(): string {
  try {
    const configured = globalThis.localStorage?.getItem(QWEN_TTS_BASE_URL_KEY)?.trim();
    return (configured || DEFAULT_QWEN_TTS_BASE_URL).replace(/\/+$/, '');
  } catch {
    return DEFAULT_QWEN_TTS_BASE_URL;
  }
}

/** Set the server URL from app settings or a developer console. */
export function setQwenTTSBaseUrl(url: string): void {
  const normalized = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('Qwen TTS URL must start with http:// or https://');
  }
  globalThis.localStorage?.setItem(QWEN_TTS_BASE_URL_KEY, normalized);
}

const QWEN_VOICES: TTSVoice[] = [
  // Cloned narrator: only meaningful when the server runs in clone mode
  // (the CustomVoice server maps it to Serena).
  { id: 'Narrateur', name: 'Narrateur · voix clonée', lang: 'fr-FR' },
  { id: 'Vivian', name: 'Vivian · expressive', lang: 'fr-FR' },
  { id: 'Serena', name: 'Serena · douce', lang: 'fr-FR' },
  { id: 'Uncle_Fu', name: 'Uncle Fu · grave', lang: 'fr-FR' },
  { id: 'Dylan', name: 'Dylan · jeune', lang: 'fr-FR' },
  { id: 'Eric', name: 'Eric · posé', lang: 'fr-FR' },
  { id: 'Ryan', name: 'Ryan · narrateur', lang: 'fr-FR' },
  { id: 'Aiden', name: 'Aiden · clair', lang: 'fr-FR' },
  { id: 'Ono_Anna', name: 'Ono Anna', lang: 'fr-FR' },
  { id: 'Sohee', name: 'Sohee', lang: 'fr-FR' },
];

function languageName(locale: string): string {
  const base = locale.toLowerCase().split('-')[0] ?? '';
  const names: Record<string, string> = {
    fr: 'French', en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
    de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
  };
  return names[base] || locale || 'Auto';
}

/**
 * Qwen is prompted to keep the book's main language stable. This is guidance,
 * not a substitute for the planned context-aware lexicon; the server may also
 * use this field to implement custom pronunciation dictionaries.
 */
export function buildQwenInstructions(locale: string): string {
  const language = languageName(locale);
  return `Read this book passage naturally in ${language}. Keep one consistent narrator voice. ` +
    `For foreign words, names, quotations and code-switching, use the pronunciation ` +
    `appropriate to the sentence context; do not switch the whole passage's accent. ` +
    `When a word is shared by English and French and the passage is French, prefer ` +
    `the established French pronunciation unless the context clearly indicates English.`;
}

export class QwenSpeechProvider implements SpeechProvider {
  readonly id = 'qwen-tts';
  readonly label = 'Qwen3-TTS (serveur)';
  readonly cacheable = true;
  #available = false;

  async init(): Promise<boolean> {
    try {
      const response = await fetch(`${getQwenTTSBaseUrl()}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2500),
      });
      this.#available = response.ok;
      serverMaxBatch = null;
      if (response.ok) {
        // Optional: an older server (or a mock) without a JSON body is fine.
        try {
          const health = (await response.json()) as { max_batch?: unknown };
          const advertised = Number(health?.max_batch);
          if (Number.isFinite(advertised) && advertised >= 1) serverMaxBatch = advertised;
        } catch {
          // Keep the default concurrency.
        }
      }
    } catch {
      this.#available = false;
    }
    return this.#available;
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#available ? QWEN_VOICES.map((voice) => ({ ...voice })) : [];
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const voice = QWEN_VOICES.find((candidate) => candidate.id === req.voice);
    if (!voice) throw new SpeechSynthesisPermanentError(`Unknown Qwen voice: ${req.voice}`);

    const response = await fetch(`${getQwenTTSBaseUrl()}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      signal,
      body: JSON.stringify({
        model: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
        input: req.text,
        voice: req.voice,
        language: languageName(req.lang),
        instructions: buildQwenInstructions(req.lang),
        response_format: 'mp3',
      }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      if (response.status >= 400 && response.status < 500) {
        throw new SpeechSynthesisPermanentError(
          `Qwen TTS rejected the request (${response.status}): ${detail || response.statusText}`,
        );
      }
      throw new Error(`Qwen TTS server error (${response.status}): ${detail}`);
    }
    const audio = await response.arrayBuffer();
    if (audio.byteLength < 44) {
      throw new SpeechSynthesisPermanentError('Qwen TTS returned an empty or invalid audio response');
    }
    // The server returns MP3 (so packed chapters are valid MP3 files) without word timings. Readest will use
    // its normal sentence-level highlighting fallback.
    return { audio, boundaries: [] };
  }

  pickDefaultVoice(voices: TTSVoice[]): string | undefined {
    return voices.find((voice) => voice.id === 'Narrateur')?.id || voices[0]?.id;
  }
}

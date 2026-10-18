import { AppService } from '@/types/system';
import { BufferedTTSClient } from './BufferedTTSClient';
import { CachingProvider } from './providers/cache';
import { QwenSpeechProvider } from './providers/qwen';
import { SpeechProvider } from './providers/types';
import type { TTSController } from './TTSController';

/** Qwen shares Readest's buffered playback, preload and chapter-cache pipeline. */
export class QwenTTSClient extends BufferedTTSClient {
  #qwenProvider: QwenSpeechProvider;

  // `cacheStore` is the book's shared per-book cache (one cache.db for every
  // engine, created by the controller); null/absent means no persistent cache.
  constructor(
    controller?: TTSController,
    appService?: AppService | null,
    cacheStore?: ConstructorParameters<typeof CachingProvider>[1] | null,
  ) {
    const qwenProvider = new QwenSpeechProvider();
    const provider: SpeechProvider = cacheStore
      ? new CachingProvider(qwenProvider, cacheStore)
      : qwenProvider;
    super(provider, controller, appService);
    this.#qwenProvider = qwenProvider;
  }

  override async init(): Promise<boolean> {
    const ok = await this.#qwenProvider.init();
    this.voices = await this.#qwenProvider.getAllVoices();
    this.initialized = ok;
    return ok;
  }

  override async getVoices(lang: string) {
    // Re-probe so a server started after Readest can become available without
    // restarting the app. A warm persistent cache remains useful offline.
    if (!this.initialized) {
      await this.#qwenProvider.init();
      this.voices = await this.#qwenProvider.getAllVoices();
      this.initialized = this.voices.length > 0;
    }
    return super.getVoices(lang);
  }
}

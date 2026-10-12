import { AppService } from '@/types/system';
import { BufferedTTSClient } from './BufferedTTSClient';
import { BookTTSCacheStore, getTTSCacheConfig } from './providers/bookCacheStore';
import { CachingProvider } from './providers/cache';
import { QwenSpeechProvider } from './providers/qwen';
import { SpeechProvider } from './providers/types';
import type { TTSController } from './TTSController';

/** Qwen shares Readest's buffered playback, preload and chapter-cache pipeline. */
export class QwenTTSClient extends BufferedTTSClient {
  #qwenProvider: QwenSpeechProvider;

  constructor(controller?: TTSController, appService?: AppService | null) {
    const qwenProvider = new QwenSpeechProvider();
    let provider: SpeechProvider = qwenProvider;
    const cacheConfig = getTTSCacheConfig();
    if (appService && cacheConfig.enabled) {
      const store = new BookTTSCacheStore(
        appService,
        () => controller?.bookKey?.split('-')[0] || null,
        cacheConfig.budgetMB * 1024 * 1024,
      );
      provider = new CachingProvider(qwenProvider, store);
    }
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

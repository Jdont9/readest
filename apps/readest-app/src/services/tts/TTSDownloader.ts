// Headless pre-synthesis of TTS audio for offline use (design section 10 in
// .agents/plans/2026-07-13-tts-cache-sqlite-packs.md). Given a set of
// sections, it walks each section's sentences through the SAME synthesis
// pipeline as live playback — minus the audio — populating the per-book
// cache and recording the section manifest so the sections compact into
// downloadable packs.
//
// The foliate/document coupling is isolated behind SectionEnumerator (the
// live pipeline: per-block SSML -> proofread preprocess -> parseSSMLMarks ->
// per-mark language/text, ordered and labelled identically to what playback
// produces). CacheWarmer is the client. This module owns only the ordering,
// progress, and cancellation, so it is fully unit-testable with fakes.

export interface DownloadableSentence {
  // Position in the section, 1:1 with the live timeline enumeration.
  ordinal: number;
  // `${blockIndex}:${markName}` — the manifest identity, must match the label
  // ensureTimeline registers during live playback so the fingerprints agree.
  label: string;
  lang: string;
  // The preprocessed sentence text: exactly what live playback synthesizes,
  // so the computed cache key is identical.
  text: string;
}

export interface SectionEnumerator {
  // Enumerate one section's sentences in reading order, or null when the
  // section is unavailable (no document, wrong client). Never throws.
  enumerateSection(sectionIndex: number): Promise<DownloadableSentence[] | null>;
}

export interface CacheWarmer {
  registerSectionManifest(section: number, labels: string[]): void | Promise<void>;
  // Synthesize this sentence into the cache (a hit is a no-op) and record its
  // key against the section manifest at the ordinal. Returns whether audio is
  // now cached for it (false = offline miss / permanent failure).
  warmSentence(
    section: number,
    ordinal: number,
    lang: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  // Force any newly-completed sections to compact into packs now (and push,
  // if pack sync is on) rather than waiting for the debounced timer.
  compactCache(): Promise<void>;
}

export interface SectionDownloadProgress {
  sectionIndex: number;
  total: number;
  // Sentences processed so far in this section (attempted, cached or skipped).
  done: number;
  // Sentences actually synthesized so far (cache misses that succeeded).
  synthesized: number;
}

export interface DownloadResult {
  completed: number[];
  skipped: number[];
  synthesized: number;
}

export interface TTSDownloaderOptions {
  // Sentences of one section synthesized at the same time. Servers that can
  // batch requests (Qwen) go much faster with several in flight; engines that
  // rate-limit keep the default of 1 (strictly sequential).
  concurrency?: number;
}

export class TTSDownloader {
  #enumerator: SectionEnumerator;
  #warmer: CacheWarmer;
  #concurrency: number;

  constructor(
    enumerator: SectionEnumerator,
    warmer: CacheWarmer,
    options: TTSDownloaderOptions = {},
  ) {
    this.#enumerator = enumerator;
    this.#warmer = warmer;
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  }

  async download(
    sectionIndexes: number[],
    onProgress?: (progress: SectionDownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<DownloadResult> {
    const completed: number[] = [];
    const skipped: number[] = [];
    let synthesizedTotal = 0;

    for (const sectionIndex of sectionIndexes) {
      if (signal?.aborted) break;
      const sentences = await this.#enumerator.enumerateSection(sectionIndex);
      if (!sentences) {
        console.warn('[TTS] download section failed to enumerate', sectionIndex);
        skipped.push(sectionIndex);
        continue;
      }

      await this.#warmer.registerSectionManifest(
        sectionIndex,
        sentences.map((s) => s.label),
      );

      let synthesized = 0;
      let failed = false;
      let aborted = false;
      let next = 0;
      let done = 0;
      // A sliding window of `concurrency` workers pulling the next sentence in
      // reading order. Completion order may differ, but every result is keyed
      // by its ordinal, so the manifest and the pack stay in reading order.
      const worker = async () => {
        for (;;) {
          if (signal?.aborted) {
            if (next < sentences.length) aborted = true;
            return;
          }
          const index = next++;
          if (index >= sentences.length) return;
          const s = sentences[index]!;
          const ok = await this.#warmer.warmSentence(
            sectionIndex,
            s.ordinal,
            s.lang,
            s.text,
            signal,
          );
          if (ok) synthesized++;
          else failed = true;
          done++;
          onProgress?.({ sectionIndex, total: sentences.length, done, synthesized });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(this.#concurrency, sentences.length) }, worker),
      );

      // Compact whatever completed. A section left partial by an abort or an
      // offline miss simply will not form a pack until the gap fills on a
      // later run; compacting is still safe and cheap.
      await this.#warmer.compactCache();
      synthesizedTotal += synthesized;
      if (aborted) break;
      if (failed) skipped.push(sectionIndex);
      else completed.push(sectionIndex);
    }

    return { completed, skipped, synthesized: synthesizedTotal };
  }
}

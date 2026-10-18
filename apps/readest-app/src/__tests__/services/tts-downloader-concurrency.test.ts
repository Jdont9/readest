import { describe, expect, test } from 'vitest';
import { TTSDownloader } from '@/services/tts/TTSDownloader';
import type { CacheWarmer, SectionEnumerator } from '@/services/tts/TTSDownloader';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const enumerator = (count: number): SectionEnumerator => ({
  enumerateSection: async () =>
    Array.from({ length: count }, (_, i) => ({
      ordinal: i,
      label: `0:${i}`,
      lang: 'fr',
      text: `sentence ${i}`,
    })),
});

const makeWarmer = (delay: (ordinal: number) => number) => {
  let inflight = 0;
  let maxInflight = 0;
  const started: number[] = [];
  const warmer: CacheWarmer = {
    registerSectionManifest: async () => {},
    compactCache: async () => {},
    warmSentence: async (_section, ordinal) => {
      started.push(ordinal);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await sleep(delay(ordinal));
      inflight--;
      return true;
    },
  };
  return { warmer, started, maxInflight: () => maxInflight };
};

describe('TTSDownloader concurrency', () => {
  test('defaults to strictly sequential synthesis', async () => {
    const { warmer, started, maxInflight } = makeWarmer(() => 2);
    await new TTSDownloader(enumerator(5), warmer).download([0]);
    expect(maxInflight()).toBe(1);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  test('keeps at most `concurrency` sentences in flight and finishes them all', async () => {
    const { warmer, maxInflight } = makeWarmer((o) => 2 + ((o * 7) % 5));
    const done: number[] = [];
    const result = await new TTSDownloader(enumerator(10), warmer, { concurrency: 4 }).download(
      [0],
      (progress) => done.push(progress.done),
    );
    expect(maxInflight()).toBe(4);
    expect(result).toEqual({ completed: [0], skipped: [], synthesized: 10 });
    // An initial {done: 0} report announces the total, then one per sentence.
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('stops launching sentences once aborted', async () => {
    const { warmer, started } = makeWarmer(() => 15);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await new TTSDownloader(enumerator(20), warmer, { concurrency: 3 }).download(
      [0],
      undefined,
      controller.signal,
    );
    expect(result.completed).toEqual([]);
    expect(started.length).toBeLessThan(20);
  });

  test('a failed sentence leaves the section skipped', async () => {
    const warmer: CacheWarmer = {
      registerSectionManifest: async () => {},
      compactCache: async () => {},
      warmSentence: async (_s, ordinal) => ordinal !== 2,
    };
    const result = await new TTSDownloader(enumerator(6), warmer, { concurrency: 3 }).download([0]);
    expect(result.skipped).toEqual([0]);
    expect(result.completed).toEqual([]);
  });
});

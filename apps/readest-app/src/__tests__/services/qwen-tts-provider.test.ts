import { afterEach, describe, expect, test, vi } from 'vitest';
import { QwenSpeechProvider, buildQwenInstructions } from '@/services/tts/providers/qwen';

afterEach(() => vi.restoreAllMocks());

describe('QwenSpeechProvider', () => {
  test('offers the provider voice catalog after the health endpoint responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
    const provider = new QwenSpeechProvider();
    await expect(provider.init()).resolves.toBe(true);
    const voices = await provider.getAllVoices();
    expect(voices.length).toBeGreaterThan(1);
    expect(voices.every((voice) => voice.lang === 'fr-FR')).toBe(true);
  });

  test('sends text, voice and context guidance to the server', async () => {
    const audio = new Uint8Array(64);
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
        .mockResolvedValueOnce(new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } })),
    );
    const provider = new QwenSpeechProvider();
    await provider.init();
    const result = await provider.synthesize(
      { lang: 'fr-FR', text: 'Elle ouvrit le chat.', voice: 'Serena', pitch: 1 },
      new AbortController().signal,
    );
    expect(result.audio.byteLength).toBe(64);
    expect(result.boundaries).toEqual([]);
    const request = vi.mocked(fetch).mock.calls[1]?.[1];
    const payload = JSON.parse(String(request?.body));
    expect(payload.input).toBe('Elle ouvrit le chat.');
    expect(payload.language).toBe('French');
    expect(payload.instructions).toContain('sentence context');
  });

  test('guidance defaults shared French/English words to French in French passages', () => {
    expect(buildQwenInstructions('fr-FR')).toContain('prefer the established French pronunciation');
  });
});

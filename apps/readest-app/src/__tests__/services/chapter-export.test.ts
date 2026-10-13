import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  chapterExportFileName,
  exportChapterAudio,
  sanitizeFileName,
  setTTSExportDir,
} from '@/services/tts/chapterExport';
import type { AppService } from '@/types/system';

vi.mock('@tauri-apps/api/path', () => ({
  join: async (dir: string, name: string) => `${dir}/${name}`,
}));

const chapter = { label: 'T', startSection: 2, endSection: 4, order: 2, orderTotal: 9 };

describe('chapter export naming', () => {
  test('prefixes a zero-padded reading-order number', () => {
    expect(chapterExportFileName({ ...chapter, label: 'Intro', order: 7, orderTotal: 250 })).toBe(
      '007 - Intro.mp3',
    );
    expect(chapterExportFileName({ ...chapter, order: 1, orderTotal: 12 })).toBe('01 - T.mp3');
  });

  test('falls back to the start section for rows queued before order existed', () => {
    expect(chapterExportFileName({ label: 'A', startSection: 4, endSection: 5 })).toBe('05 - A.mp3');
  });

  test('removes characters illegal in file names', () => {
    expect(sanitizeFileName('Ch. 1 : « L’arrivée » ?/\\*')).toBe('Ch. 1 « L’arrivée »');
    expect(sanitizeFileName('  ...  ')).toBe('Chapter');
  });
});

describe('exportChapterAudio', () => {
  const files = new Map<string, Uint8Array>();
  const appService = {
    createDir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, _base: string, data: ArrayBuffer) => {
      files.set(path, new Uint8Array(data));
    }),
  } as unknown as AppService;
  const packReader = {
    readSectionPack: async (s: number) => new Uint8Array([s, s]).buffer as ArrayBuffer,
  };

  beforeEach(() => {
    files.clear();
    localStorage.clear();
  });
  afterEach(() => vi.clearAllMocks());

  test('does nothing without an export folder', async () => {
    expect(await exportChapterAudio(appService, packReader, chapter)).toBeNull();
    expect(files.size).toBe(0);
  });

  test('concatenates the chapter sections into one named file', async () => {
    setTTSExportDir('/sdcard/Audio');
    expect(await exportChapterAudio(appService, packReader, chapter)).toBe('02 - T.mp3');
    expect(Array.from(files.get('/sdcard/Audio/02 - T.mp3')!)).toEqual([2, 2, 3, 3]);
  });

  test('skips when a section is not packed or the audio is WAV', async () => {
    setTTSExportDir('/sdcard/Audio');
    const missing = { readSectionPack: async (s: number) => (s === 3 ? null : new ArrayBuffer(2)) };
    expect(await exportChapterAudio(appService, missing, chapter)).toBeNull();
    const wav = { readSectionPack: async () => new TextEncoder().encode('RIFFxxxx').buffer as ArrayBuffer };
    expect(await exportChapterAudio(appService, wav, chapter)).toBeNull();
    expect(files.size).toBe(0);
  });
});

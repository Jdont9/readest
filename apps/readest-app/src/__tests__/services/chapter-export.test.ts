import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  bookFolderName,
  buildId3Tag,
  buildXingFrame,
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
    expect(await exportChapterAudio(appService, packReader, chapter)).toEqual({
      ok: false,
      reason: 'no-folder',
    });
    expect(files.size).toBe(0);
  });

  test('concatenates the chapter sections into one named file', async () => {
    setTTSExportDir('/sdcard/Audio');
    const book = { title: 'Silo: Part 1', author: 'Hugh Howey' };
    expect(await exportChapterAudio(appService, packReader, chapter, book)).toEqual({
      ok: true,
      name: 'Silo Part 1/02 - T.mp3',
    });
    const written = files.get('/sdcard/Audio/Silo Part 1/02 - T.mp3')!;
    // An ID3v2.3 tag first, then the section audio in order.
    expect(String.fromCharCode(...written.slice(0, 3))).toBe('ID3');
    expect(Array.from(written.slice(-4))).toEqual([2, 2, 3, 3]);
  });

  test('ignores empty (zero-byte) sections, e.g. trailing blank pages', async () => {
    setTTSExportDir('/sdcard/Audio');
    const reader = {
      readSectionPack: async (s: number) =>
        s === 3 ? new ArrayBuffer(0) : (new Uint8Array([s, s]).buffer as ArrayBuffer),
    };
    const result = await exportChapterAudio(appService, reader, chapter, { title: 'B' });
    expect(result).toEqual({ ok: true, name: 'B/02 - T.mp3' });
    expect(Array.from(files.get('/sdcard/Audio/B/02 - T.mp3')!.slice(-2))).toEqual([2, 2]);
  });

  test('reports no-audio when every section of the chapter is empty', async () => {
    setTTSExportDir('/sdcard/Audio');
    const empty = { readSectionPack: async () => new ArrayBuffer(0) };
    expect(await exportChapterAudio(appService, empty, chapter)).toEqual({
      ok: false,
      reason: 'no-audio',
    });
    expect(files.size).toBe(0);
  });

  test('skips when a section is not packed or the audio is WAV', async () => {
    setTTSExportDir('/sdcard/Audio');
    const missing = { readSectionPack: async (s: number) => (s === 3 ? null : new ArrayBuffer(2)) };
    expect(await exportChapterAudio(appService, missing, chapter)).toEqual({
      ok: false,
      reason: 'not-packed',
    });
    const wav = { readSectionPack: async () => new TextEncoder().encode('RIFFxxxx').buffer as ArrayBuffer };
    expect(await exportChapterAudio(appService, wav, chapter)).toEqual({
      ok: false,
      reason: 'wav-audio',
    });
    expect(files.size).toBe(0);
  });
});

describe('ID3 tag and book folder', () => {
  test('writes a well-formed ID3v2.3 tag with UTF-16 text frames', () => {
    const tag = buildId3Tag({ title: 'Arrivée', album: 'Silo', artist: 'Hugh Howey', track: 7, trackTotal: 53 });
    expect(String.fromCharCode(...tag.slice(0, 3))).toBe('ID3');
    expect(tag[3]).toBe(3);
    const size = (tag[6]! << 21) | (tag[7]! << 14) | (tag[8]! << 7) | tag[9]!;
    expect(size).toBe(tag.length - 10);
    // "7/53" as UTF-16LE, as stored in the TRCK frame (frame headers are not
    // 2-byte aligned, so search the bytes rather than decoding the whole tag).
    const utf16 = (text: string) => Array.from(text).flatMap((c) => [c.charCodeAt(0), 0]);
    expect(Array.from(tag).join(',')).toContain(utf16('7/53').join(','));
  });

  test('names the book folder safely', () => {
    expect(bookFolderName({ title: '  Le Seigneur/des "Anneaux"  ' })).toBe('Le Seigneur des Anneaux');
    expect(bookFolderName({})).toBe('Livre');
  });
});

describe('Xing header', () => {
  // MPEG-2 Layer III, 24 kHz, mono, 64 kbps => 192-byte frames of 576 samples.
  const frame = () => {
    const f = new Uint8Array(192);
    f.set([0xff, 0xf3, 0x80 | (1 << 2), 0xc0]);
    return f;
  };
  const audio = (frames: number) => {
    const out = new Uint8Array(frames * 192);
    for (let i = 0; i < frames; i++) out.set(frame(), i * 192);
    return out;
  };

  test('records the real frame count and size', () => {
    const xing = buildXingFrame(audio(500))!;
    const view = new DataView(xing.buffer);
    expect(String.fromCharCode(...xing.slice(13, 17))).toBe('Xing'); // 4 header + 9 side info
    expect(view.getUint32(13 + 8)).toBe(500);
    expect(view.getUint32(13 + 12)).toBe(xing.length + 500 * 192);
  });

  test('is a valid frame itself and returns null for non-MP3 data', () => {
    const xing = buildXingFrame(audio(10))!;
    expect(xing[0]).toBe(0xff);
    expect((xing[1]! & 0xe0)).toBe(0xe0);
    expect(buildXingFrame(new Uint8Array(1000))).toBeNull();
  });
});

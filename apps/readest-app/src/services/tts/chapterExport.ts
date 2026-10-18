// Optional export of downloaded chapters as plain MP3 files in a folder the
// user picked, named "<NN> - <chapter title>.mp3" so they sort in reading
// order in any file manager or audio player.
//
// The per-book cache keeps one pack per section: its sentence MP3s
// concatenated in reading order, i.e. already a playable MP3. A chapter spans
// one or more sections, so the export is those packs concatenated. Export is
// strictly best-effort: a failure here must never fail the download itself.

import type { AppService } from '@/types/system';
import type { DownloadChapter } from './downloadChapters';

const CONFIG_KEY = 'readest-tts-export-dir';
const MAX_BASENAME_LENGTH = 100;

export const getTTSExportDir = (): string => {
  try {
    return localStorage.getItem(CONFIG_KEY)?.trim() || '';
  } catch {
    return '';
  }
};

export const setTTSExportDir = (dir: string): void => {
  try {
    if (dir) localStorage.setItem(CONFIG_KEY, dir);
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    // Storage unavailable; export simply stays off.
  }
};

// Strip characters that are illegal on Windows/Android/FAT file systems and
// keep the name a sane length. Falls back to "Chapter" for empty labels.
export const sanitizeFileName = (label: string): string => {
  const cleaned = label
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const truncated = Array.from(cleaned).slice(0, MAX_BASENAME_LENGTH).join('').trim();
  return truncated || 'Chapter';
};

type ExportableChapter = Pick<
  DownloadChapter,
  'label' | 'startSection' | 'endSection' | 'order' | 'orderTotal'
>;

// "007 - Chapter title.mp3". The number is zero-padded to the width of the
// chapter count (at least 2) so lexicographic order equals reading order even
// past 99 chapters. Rows queued before `order` existed fall back to the
// start section, which is also monotonic in reading order.
export const chapterExportFileName = (chapter: ExportableChapter): string => {
  const order = chapter.order ?? chapter.startSection + 1;
  const total = Math.max(chapter.orderTotal ?? 0, order);
  const width = Math.max(2, String(total).length);
  return `${String(order).padStart(width, '0')} - ${sanitizeFileName(chapter.label)}.mp3`;
};

export interface ExportBookInfo {
  title?: string;
  author?: string;
}

// One sub-folder per book inside the chosen export folder.
export const bookFolderName = (book?: ExportBookInfo): string =>
  sanitizeFileName(book?.title || 'Livre');

// ---- ID3v2.3 tag --------------------------------------------------------
// A minimal writer: text frames only, UTF-16 with BOM (the encoding every
// player understands in v2.3). The tag is prepended to the MP3 stream.

const utf16Frame = (id: string, text: string): Uint8Array => {
  const body = new Uint8Array(1 + 2 + text.length * 2);
  body[0] = 0x01; // UTF-16 with BOM
  body[1] = 0xff; // BOM, little-endian
  body[2] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    body[3 + i * 2] = code & 0xff;
    body[4 + i * 2] = code >> 8;
  }
  const frame = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  new DataView(frame.buffer).setUint32(4, body.length); // plain big-endian size in v2.3
  frame.set(body, 10);
  return frame;
};

export interface ChapterTagInfo {
  title: string; // this chapter
  album?: string; // the book
  artist?: string; // the author
  track?: number;
  trackTotal?: number;
}

export const buildId3Tag = (info: ChapterTagInfo): Uint8Array => {
  const frames: Uint8Array[] = [utf16Frame('TIT2', info.title)];
  if (info.album) frames.push(utf16Frame('TALB', info.album));
  if (info.artist) {
    frames.push(utf16Frame('TPE1', info.artist));
    frames.push(utf16Frame('TPE2', info.artist));
  }
  if (info.track) {
    const track = info.trackTotal ? `${info.track}/${info.trackTotal}` : String(info.track);
    frames.push(utf16Frame('TRCK', track));
  }
  frames.push(utf16Frame('TCON', 'Audiobook'));

  const size = frames.reduce((sum, frame) => sum + frame.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]); // "ID3", v2.3.0, no flags
  // Tag size is a 28-bit "syncsafe" integer (7 bits per byte).
  tag.set([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], 6);
  let offset = 10;
  for (const frame of frames) {
    tag.set(frame, offset);
    offset += frame.length;
  }
  return tag;
};

// ---- Xing/VBR header ------------------------------------------------------
// Qwen's MP3s are variable-bitrate and packs are many MP3 streams glued
// together, so there is no duration header: players then guess the length from
// the first frames' bitrate (a 12 minute chapter showed as 40 minutes). A Xing
// frame in front of the audio carries the real frame count, byte size and a
// seek table, so players show the true length and seek correctly.

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

interface Mp3FrameInfo {
  length: number;
  samples: number;
}

const readFrame = (data: Uint8Array, i: number): Mp3FrameInfo | null => {
  if (i + 4 > data.length || data[i] !== 0xff || (data[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (data[i + 1]! >> 3) & 3;
  const layer = (data[i + 1]! >> 1) & 3;
  const bitrateIndex = data[i + 2]! >> 4;
  const rateIndex = (data[i + 2]! >> 2) & 3;
  const padding = (data[i + 2]! >> 1) & 1;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
    return null;
  }
  const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[bitrateIndex]! * 1000;
  const samples = mpeg1 ? 1152 : 576;
  return { length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding, samples };
};

// Returns the Xing frame for this audio, or null when it does not parse as
// MPEG Layer III (then the file is simply written without one).
export const buildXingFrame = (audio: Uint8Array): Uint8Array | null => {
  // Locate the first real frame (two consecutive valid headers rule out false syncs).
  let start = -1;
  for (let i = 0; i < Math.min(audio.length - 4, 65536); i++) {
    const frame = readFrame(audio, i);
    if (frame && readFrame(audio, i + frame.length)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const offsets: number[] = []; // byte position of each frame, relative to `start`
  let samples = 0;
  for (let i = start; i < audio.length; ) {
    const frame = readFrame(audio, i);
    if (!frame || i + frame.length > audio.length) {
      // Resync on garbage/trailing bytes instead of giving up.
      i++;
      continue;
    }
    offsets.push(i - start);
    samples = frame.samples;
    i += frame.length;
  }
  if (!offsets.length) return null;

  const version = (audio[start + 1]! >> 3) & 3;
  const rateIndex = (audio[start + 2]! >> 2) & 3;
  const mono = (audio[start + 3]! >> 6) === 3;
  const mpeg1 = version === 3;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const needed = 4 + sideInfo + 4 + 4 + 4 + 4 + 100; // header, side info, "Xing", flags, frames, bytes, TOC
  const table = mpeg1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES;
  const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
  let bitrateIndex = 1;
  while (
    bitrateIndex < 14 &&
    Math.floor(((samples / 8) * table[bitrateIndex]! * 1000) / sampleRate) < needed
  ) {
    bitrateIndex++;
  }
  const frameLength = Math.floor(((samples / 8) * table[bitrateIndex]! * 1000) / sampleRate);

  const xing = new Uint8Array(frameLength);
  xing[0] = 0xff;
  xing[1] = audio[start + 1]! | 0x01; // no CRC
  xing[2] = (bitrateIndex << 4) | (rateIndex << 2);
  xing[3] = audio[start + 3]!;
  const view = new DataView(xing.buffer);
  let p = 4 + sideInfo;
  xing.set([0x58, 0x69, 0x6e, 0x67], p); // "Xing" = VBR
  view.setUint32(p + 4, 0x07); // flags: frames + bytes + TOC
  view.setUint32(p + 8, offsets.length);
  const audioBytes = audio.length - start;
  view.setUint32(p + 12, frameLength + audioBytes);
  p += 16;
  for (let i = 0; i < 100; i++) {
    const position = offsets[Math.floor((i / 100) * offsets.length)]! + frameLength;
    xing[p + i] = Math.min(255, Math.floor((position / (frameLength + audioBytes)) * 256));
  }
  return xing;
};

export interface SectionPackReader {
  readSectionPack(section: number): Promise<ArrayBuffer | null>;
}

const isRiff = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;

export type ChapterExportResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'no-folder' | 'not-packed' | 'wav-audio' | 'no-audio' };

// Never throws for expected situations: the reason says why nothing was
// written so the caller can tell the user instead of failing silently.
export const exportChapterAudio = async (
  appService: AppService,
  reader: SectionPackReader,
  chapter: ExportableChapter,
  book?: ExportBookInfo,
): Promise<ChapterExportResult> => {
  const dir = getTTSExportDir();
  if (!dir) return { ok: false, reason: 'no-folder' };

  const parts: Uint8Array[] = [];
  for (let section = chapter.startSection; section < chapter.endSection; section++) {
    const pack = await reader.readSectionPack(section);
    if (!pack) return { ok: false, reason: 'not-packed' };
    // Packed but empty: a section with no text (blank page, image). Skip it.
    if (pack.byteLength === 0) continue;
    const bytes = new Uint8Array(pack);
    if (isRiff(bytes)) {
      // Audio cached before the server switched to MP3: concatenated WAVs are
      // not a valid file. Clear the book's offline audio and download again.
      console.warn('[TTS] chapter export skipped: cached audio is WAV, not MP3');
      return { ok: false, reason: 'wav-audio' };
    }
    parts.push(bytes);
  }
  // Every section of this "chapter" was empty (e.g. a trailing blank page).
  if (!parts.length) return { ok: false, reason: 'no-audio' };

  const tag = buildId3Tag({
    title: chapter.label,
    album: book?.title,
    artist: book?.author,
    track: chapter.order ?? chapter.startSection + 1,
    trackTotal: chapter.orderTotal,
  });
  const audio = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let audioOffset = 0;
  for (const part of parts) {
    audio.set(part, audioOffset);
    audioOffset += part.length;
  }
  const xing = buildXingFrame(audio) ?? new Uint8Array(0);
  const merged = new Uint8Array(tag.length + xing.length + audio.length);
  merged.set(tag, 0);
  merged.set(xing, tag.length);
  merged.set(audio, tag.length + xing.length);

  const { join } = await import('@tauri-apps/api/path');
  const name = chapterExportFileName(chapter);
  const bookDir = await join(dir, bookFolderName(book));
  await appService.createDir(bookDir, 'None', true);
  await appService.writeFile(await join(bookDir, name), 'None', merged.buffer as ArrayBuffer);
  return { ok: true, name: `${bookFolderName(book)}/${name}` };
};

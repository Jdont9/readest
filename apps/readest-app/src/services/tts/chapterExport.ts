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

export interface SectionPackReader {
  readSectionPack(section: number): Promise<ArrayBuffer | null>;
}

const isRiff = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;

// Returns the written file name, or null when nothing was exported (no folder
// configured, a section is not packed yet, or the audio is not MP3).
export const exportChapterAudio = async (
  appService: AppService,
  reader: SectionPackReader,
  chapter: ExportableChapter,
): Promise<string | null> => {
  const dir = getTTSExportDir();
  if (!dir) return null;

  const parts: Uint8Array[] = [];
  for (let section = chapter.startSection; section < chapter.endSection; section++) {
    const pack = await reader.readSectionPack(section);
    if (!pack) return null;
    const bytes = new Uint8Array(pack);
    if (isRiff(bytes)) {
      // Audio cached before the server switched to MP3: concatenated WAVs are
      // not a valid file. Clear the book's offline audio and download again.
      console.warn('[TTS] chapter export skipped: cached audio is WAV, not MP3');
      return null;
    }
    parts.push(bytes);
  }
  if (!parts.length) return null;

  const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  const { join } = await import('@tauri-apps/api/path');
  const name = chapterExportFileName(chapter);
  await appService.createDir(dir, 'None', true);
  await appService.writeFile(await join(dir, name), 'None', merged.buffer as ArrayBuffer);
  return name;
};

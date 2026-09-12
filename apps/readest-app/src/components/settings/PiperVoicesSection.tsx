import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { PiperSpeechProvider } from '@/services/tts/providers/piper';
import { PiperVoiceManager, PiperDownloadProgress } from '@/services/tts/providers/piperVoiceManager';
import { PiperVoiceDescriptor } from '@/services/tts/providers/piperVoices';
import { BoxedList, SettingsRow } from './primitives';

type VoiceRowState = 'idle' | 'downloading' | 'downloaded' | 'error';

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// Standalone: owns its own PiperSpeechProvider/PiperVoiceManager rather than
// reaching into a live reader session's TTSController, so it works from
// Settings whether or not a book is currently open. TTSController picks up
// newly-downloaded voices itself next time it calls
// PiperTTSClient.refreshVoices() (on the next `init()`/voice-picker open).
const PiperVoicesSection: React.FC = () => {
  const _ = useTranslation();
  const managerRef = useRef<PiperVoiceManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new PiperVoiceManager(new PiperSpeechProvider());
  }
  const manager = managerRef.current;

  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, VoiceRowState>>({});
  const [progress, setProgress] = useState<Record<string, PiperDownloadProgress>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const catalog = useMemo(() => manager.listCatalog(), [manager]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ok = await manager.init();
        if (cancelled) return;
        setAvailable(ok);
        const states: Record<string, VoiceRowState> = {};
        catalog.forEach((v) => {
          states[v.id] = manager.isDownloaded(v.id) ? 'downloaded' : 'idle';
        });
        setRowStates(states);
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[PiperVoicesSection] init failed', err);
        setAvailable(false);
        setInitError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    const unsubscribe = manager.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p }));
      if (p.done) {
        setRowStates((prev) => ({ ...prev, [p.id]: p.error ? 'error' : 'downloaded' }));
        if (p.error) {
          setErrors((prev) => ({ ...prev, [p.id]: p.error! }));
        }
      } else {
        setRowStates((prev) => ({ ...prev, [p.id]: 'downloading' }));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only hide silently before we know anything yet. Once we know (ready),
  // always show something: the catalog, or — if init failed — the actual
  // error, so a real Android-side bug is visible instead of a blank
  // section that looks like Piper was never wired up at all.
  if (!ready) return null;

  if (!available) {
    return (
      <BoxedList
        title={_('Offline Voices (Piper)')}
        description={initError ?? _('Piper TTS is not available on this build.')}
        data-setting-id='settings.tts.piperVoices'
      >
        <></>
      </BoxedList>
    );
  }

  const handleDownload = async (voice: PiperVoiceDescriptor) => {
    setErrors((prev) => ({ ...prev, [voice.id]: '' }));
    setRowStates((prev) => ({ ...prev, [voice.id]: 'downloading' }));
    try {
      await manager.downloadVoice(voice.id);
      setRowStates((prev) => ({ ...prev, [voice.id]: 'downloaded' }));
    } catch (err) {
      setRowStates((prev) => ({ ...prev, [voice.id]: 'error' }));
      setErrors((prev) => ({
        ...prev,
        [voice.id]: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleCancel = async (voice: PiperVoiceDescriptor) => {
    await manager.cancelDownload(voice.id);
    setRowStates((prev) => ({ ...prev, [voice.id]: 'idle' }));
  };

  const handleDelete = async (voice: PiperVoiceDescriptor) => {
    await manager.deleteVoice(voice.id);
    setRowStates((prev) => ({ ...prev, [voice.id]: 'idle' }));
    setProgress((prev) => ({ ...prev, [voice.id]: undefined as never }));
  };

  return (
    <BoxedList
      title={_('Offline Voices (Piper)')}
      description={_(
        'Neural voices that run entirely on this device — no network needed once downloaded.',
      )}
      data-setting-id='settings.tts.piperVoices'
    >
      {catalog.map((voice) => {
        const state = rowStates[voice.id] ?? 'idle';
        const p = progress[voice.id];
        const pct =
          p && p.totalBytes > 0 ? Math.min(100, Math.round((p.bytesDownloaded / p.totalBytes) * 100)) : 0;
        return (
          <SettingsRow
            key={voice.id}
            label={voice.name}
            description={
              state === 'downloading'
                ? _('Downloading… {{pct}}%', { pct })
                : state === 'error'
                  ? (errors[voice.id] ?? _('Download failed'))
                  : `${voice.lang} · ${formatSize(voice.sizeBytes)}`
            }
          >
            {state === 'downloaded' && (
              <button
                className='btn btn-sm btn-ghost text-error'
                onClick={() => handleDelete(voice)}
                aria-label={_('Remove voice')}
              >
                {_('Remove')}
              </button>
            )}
            {state === 'downloading' && (
              <button
                className='btn btn-sm btn-ghost'
                onClick={() => handleCancel(voice)}
                aria-label={_('Cancel download')}
              >
                {_('Cancel')}
              </button>
            )}
            {(state === 'idle' || state === 'error') && (
              <button
                className='btn btn-sm btn-ghost'
                onClick={() => handleDownload(voice)}
                aria-label={_('Download voice')}
              >
                {_('Download')}
              </button>
            )}
          </SettingsRow>
        );
      })}
    </BoxedList>
  );
};

export default PiperVoicesSection;

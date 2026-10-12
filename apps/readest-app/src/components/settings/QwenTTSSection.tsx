import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { BoxedList, SettingsRow } from './primitives';
import { DEFAULT_QWEN_TTS_BASE_URL, QWEN_TTS_BASE_URL_KEY } from '@/services/tts/providers/qwen';

const QwenTTSSection: React.FC = () => {
  const _ = useTranslation();
  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem(QWEN_TTS_BASE_URL_KEY) || DEFAULT_QWEN_TTS_BASE_URL;
    } catch {
      return DEFAULT_QWEN_TTS_BASE_URL;
    }
  });
  const [message, setMessage] = useState('');

  const save = () => {
    const normalized = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(normalized)) {
      setMessage(_('Enter a URL beginning with http:// or https://'));
      return;
    }
    try {
      localStorage.setItem(QWEN_TTS_BASE_URL_KEY, normalized);
      setMessage(_('Saved. Reload Readest to connect to the Qwen server.'));
    } catch {
      setMessage(_('Could not save the Qwen server URL on this device.'));
    }
  };

  return (
    <BoxedList title='Qwen3-TTS' data-setting-id='settings.tts.qwen'>
      <SettingsRow
        label={_('Qwen server URL')}
        description={_('Optional neural TTS server. On Android, use your computer’s LAN IP, not 127.0.0.1.')}
      >
        <div className='flex w-full flex-col gap-2 sm:max-w-sm'>
          <input
            className='w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
            type='url'
            inputMode='url'
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label={_('Qwen server URL')}
            placeholder='http://192.168.1.50:8000'
          />
          <button
            type='button'
            className='self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted'
            onClick={save}
          >
            {_('Save URL')}
          </button>
          {message && <p role='status' className='text-xs text-muted-foreground'>{message}</p>}
        </div>
      </SettingsRow>
      <p className='px-3 pb-2 text-xs text-muted-foreground'>
        {_('The Qwen model runs on the configured server. Start the Readest Qwen adapter first; chapter audio can then be cached for offline playback.')}
      </p>
    </BoxedList>
  );
};

export default QwenTTSSection;

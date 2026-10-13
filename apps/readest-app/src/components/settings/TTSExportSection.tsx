import React, { useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { requestStoragePermission } from '@/utils/permission';
import { getTTSExportDir, setTTSExportDir } from '@/services/tts/chapterExport';
import { BoxedList, SettingsRow } from './primitives';

// Native apps only: the web build has no writable user-chosen folder.
const TTSExportSection: React.FC = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [dir, setDir] = useState(getTTSExportDir);
  const [message, setMessage] = useState('');

  if (!appService || (!appService.isMobileApp && !appService.isDesktopApp)) return null;

  const pick = async () => {
    setMessage('');
    try {
      const selected = await appService.selectDirectory('write');
      if (!selected) return;
      if (appService.isAndroidApp && !selected.includes('Android/data')) {
        if (!(await requestStoragePermission())) {
          setMessage(_('Storage permission is required to write into this folder.'));
          return;
        }
      }
      setTTSExportDir(selected);
      setDir(selected);
    } catch (error) {
      console.error('Failed to select TTS export folder', error);
      setMessage(_('Failed to select directory'));
    }
  };

  const clear = () => {
    setTTSExportDir('');
    setDir('');
    setMessage('');
  };

  return (
    <BoxedList title={_('Export downloaded chapters')} data-setting-id='settings.tts.export'>
      <SettingsRow
        label={_('Export folder')}
        description={_(
          'When a chapter finishes downloading, also save it as an MP3 named “01 - Chapter title.mp3” (numbered in reading order) in this folder.',
        )}
      >
        <div className='flex w-full flex-col gap-2 sm:max-w-sm'>
          <p className='break-all text-xs text-muted-foreground'>{dir || _('No folder selected')}</p>
          <div className='flex gap-2'>
            <button
              type='button'
              className='rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted'
              onClick={pick}
            >
              {dir ? _('Change folder') : _('Choose folder')}
            </button>
            {dir && (
              <button
                type='button'
                className='rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted'
                onClick={clear}
              >
                {_('Turn off')}
              </button>
            )}
          </div>
          {message && (
            <p role='status' className='text-xs text-muted-foreground'>
              {message}
            </p>
          )}
        </div>
      </SettingsRow>
    </BoxedList>
  );
};

export default TTSExportSection;

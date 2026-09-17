import { confirm } from '@tauri-apps/plugin-dialog';
import { t } from './i18n';

// Tauri's window.confirm shim is asynchronous and uses the legacy confirm IPC.
// The supported plugin API uses message IPC, covered by dialog:default.
export async function confirmAction(message: string): Promise<boolean> {
  if ('__TAURI_INTERNALS__' in window) {
    return await confirm(message, { title: 'Dispatch', kind: 'warning', okLabel: t('确认'), cancelLabel: t('取消') });
  }
  return window.confirm(message);
}

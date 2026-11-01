/**
 * Copies text and confirms it with a toast. The Clipboard API exists only on HTTPS and localhost;
 * an installation on plain HTTP falls back to a selected textarea and execCommand.
 */
export function useCopy(): (text: string) => Promise<void> {
  const toast = useToast();
  return async (text) => {
    if (await copyText(text)) {
      toast.add({ title: t('common.copied'), icon: 'i-lucide-copy' });
    } else {
      toast.add({ color: 'error', title: t('common.copyFailed') });
    }
  };
}

async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied by the browser: try the fallback.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  // Next to the clicked button: a modal's focus trap would take the focus back from an element outside it.
  (document.activeElement?.parentElement ?? document.body).append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

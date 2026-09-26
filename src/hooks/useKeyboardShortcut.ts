import { useEffect } from 'react';

export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  options: {
    ctrl?: boolean;
    cmd?: boolean;
    shift?: boolean;
    alt?: boolean;
  } = {}
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

      const modifierMatch =
        (options.ctrl === undefined || e.ctrlKey === options.ctrl) &&
        (options.cmd === undefined || (isMac ? e.metaKey : e.ctrlKey) === options.cmd) &&
        (options.shift === undefined || e.shiftKey === options.shift) &&
        (options.alt === undefined || e.altKey === options.alt);

      if (modifierMatch && e.key.toLowerCase() === key.toLowerCase()) {
        e.preventDefault();
        callback();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key, callback, options]);
}

import { useKeyboardShortcut } from './useKeyboardShortcut';
import { usePanesStore } from '../state/panesStore';

/**
 * Hook to register keyboard shortcuts for pane splitting, closing, and navigation.
 *
 * Shortcuts:
 * - Cmd+D: Split vertically
 * - Cmd+Shift+D: Split horizontally
 * - Cmd+W: Close focused pane
 * - Cmd+Alt+Arrow (up/down/left/right): Navigate focus between panes
 */
export function usePaneSplit() {
  const { focusedPaneId, splitPane, closePane, navigateFocus } = usePanesStore();

  // Cmd+D: Split vertically
  useKeyboardShortcut('d', () => {
    console.log('[usePaneSplit] Cmd+D pressed, focusedPaneId:', focusedPaneId);
    if (!focusedPaneId) {
      console.warn('[usePaneSplit] No focused pane - cannot split');
      return;
    }

    // Generate placeholder terminal ID - actual PTY will be spawned when Terminal mounts
    const placeholderId = `pending-${crypto.randomUUID()}`;
    console.log('[usePaneSplit] Calling splitPane with paneId:', focusedPaneId, 'placeholderId:', placeholderId);
    splitPane(focusedPaneId, 'vertical', placeholderId);
  }, { cmd: true });

  // Cmd+Shift+D: Split horizontally
  useKeyboardShortcut('d', () => {
    if (!focusedPaneId) return;

    // Generate placeholder terminal ID - actual PTY will be spawned when Terminal mounts
    const placeholderId = `pending-${crypto.randomUUID()}`;
    splitPane(focusedPaneId, 'horizontal', placeholderId);
  }, { cmd: true, shift: true });

  // Cmd+W: Close focused pane
  useKeyboardShortcut('w', () => {
    if (focusedPaneId) {
      closePane(focusedPaneId);
    }
  }, { cmd: true });

  // Cmd+Alt+ArrowUp: Navigate focus up
  useKeyboardShortcut('ArrowUp', () => {
    navigateFocus('up');
  }, { cmd: true, alt: true });

  // Cmd+Alt+ArrowDown: Navigate focus down
  useKeyboardShortcut('ArrowDown', () => {
    navigateFocus('down');
  }, { cmd: true, alt: true });

  // Cmd+Alt+ArrowLeft: Navigate focus left
  useKeyboardShortcut('ArrowLeft', () => {
    navigateFocus('left');
  }, { cmd: true, alt: true });

  // Cmd+Alt+ArrowRight: Navigate focus right
  useKeyboardShortcut('ArrowRight', () => {
    navigateFocus('right');
  }, { cmd: true, alt: true });
}

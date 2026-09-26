import { useEffect, useRef, type RefObject } from "react";
import { initVimMode } from "monaco-vim";
import type * as Monaco from "monaco-editor";

type VimAttachment = {
  editor: Monaco.editor.IStandaloneCodeEditor;
  statusElement: HTMLElement;
  vimMode: ReturnType<typeof initVimMode>;
};

function disposeVimAttachment(attachment: VimAttachment): void {
  try {
    attachment.vimMode.dispose();
  } finally {
    attachment.statusElement.textContent = "";
  }
}

export function useVimMode(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  statusRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
): void {
  const attachmentRef = useRef<VimAttachment | null>(null);

  useEffect(() => {
    const statusElement = statusRef?.current;
    const attachment = attachmentRef.current;
    const attachmentMatches =
      enabled &&
      editor &&
      statusElement &&
      attachment?.editor === editor &&
      attachment.statusElement === statusElement;

    if (attachment && !attachmentMatches) {
      attachmentRef.current = null;
      disposeVimAttachment(attachment);
    }

    if (!attachmentRef.current && enabled && editor && statusElement) {
      attachmentRef.current = {
        editor,
        statusElement,
        vimMode: initVimMode(editor, statusElement),
      };
    }
  });

  useEffect(() => {
    return () => {
      const attachment = attachmentRef.current;
      attachmentRef.current = null;
      if (attachment) {
        disposeVimAttachment(attachment);
      }
    };
  }, [editor, enabled]);
}

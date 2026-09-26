import type { ReactNode } from "react";
import type * as Monaco from "monaco-editor";
import "./EditorActionToolbar.css";

type ToolbarEditor = Pick<
  Monaco.editor.IStandaloneCodeEditor,
  "focus" | "getAction" | "trigger"
>;

type EditorActionToolbarProps = {
  editor: ToolbarEditor | null;
  canSave: boolean;
  onSave: () => void;
  onOpenWorkspace?: () => void;
  onToggleExplorer?: () => void;
  onFind?: () => void;
  onReplace?: () => void;
  onWorkspaceFind?: () => void;
  onGoToSymbol?: () => void;
  onSettings?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onDetach?: () => void;
  onProblems?: () => void;
  onTerminal?: () => void;
  onAssistant?: () => void;
  extraRunActions?: ReactNode;
};

type ActionButton = {
  label: string;
  icon: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
};

function ToolbarButton({ action }: { action: ActionButton }) {
  return (
    <button
      type="button"
      aria-label={action.label}
      title={action.title}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      <span aria-hidden="true">{action.icon}</span>
    </button>
  );
}

function ToolbarGroup({
  label,
  actions,
  children,
}: {
  label: string;
  actions?: ActionButton[];
  children?: ReactNode;
}) {
  return (
    <div className="editor-action-toolbar-group" role="group" aria-label={label}>
      {actions?.map((action) => (
        <ToolbarButton key={action.label} action={action} />
      ))}
      {children}
    </div>
  );
}

export function EditorActionToolbar({
  editor,
  canSave,
  onSave,
  onOpenWorkspace,
  onToggleExplorer,
  onFind,
  onReplace,
  onWorkspaceFind,
  onGoToSymbol,
  onSettings,
  onSplitRight,
  onSplitDown,
  onDetach,
  onProblems,
  onTerminal,
  onAssistant,
  extraRunActions,
}: EditorActionToolbarProps) {
  const runCommand = (id: string) => {
    if (!editor) return;
    editor.focus();
    editor.trigger("toolbar", id, null);
  };
  const runAction = (id: string) => {
    if (!editor) return;
    editor.focus();
    void editor.getAction(id)?.run();
  };
  const editorDisabled = !editor;

  return (
    <div className="editor-action-toolbar" role="toolbar" aria-label="Editor actions">
      <ToolbarGroup
        label="File actions"
        actions={[
          {
            label: "Open workspace",
            icon: "📂",
            title: "Open workspace",
            disabled: !onOpenWorkspace,
            onClick: () => onOpenWorkspace?.(),
          },
          {
            label: "Save",
            icon: "💾",
            title: "Save",
            disabled: !canSave,
            onClick: onSave,
          },
        ]}
      />
      <ToolbarGroup
        label="Edit actions"
        actions={[
          { label: "Undo", icon: "↶", title: "Undo", disabled: editorDisabled, onClick: () => runCommand("undo") },
          { label: "Redo", icon: "↷", title: "Redo", disabled: editorDisabled, onClick: () => runCommand("redo") },
          { label: "Cut", icon: "✂", title: "Cut", disabled: editorDisabled, onClick: () => runAction("editor.action.clipboardCutAction") },
          { label: "Copy", icon: "⧉", title: "Copy", disabled: editorDisabled, onClick: () => runAction("editor.action.clipboardCopyAction") },
          { label: "Paste", icon: "📋", title: "Paste", disabled: editorDisabled, onClick: () => runAction("editor.action.clipboardPasteAction") },
          { label: "Select all", icon: "▣", title: "Select all", disabled: editorDisabled, onClick: () => runCommand("editor.action.selectAll") },
        ]}
      />
      <ToolbarGroup
        label="Search actions"
        actions={[
          { label: "Find", icon: "🔍", title: "Find", disabled: editorDisabled, onClick: onFind ?? (() => runCommand("actions.find")) },
          { label: "Replace", icon: "⇄", title: "Replace", disabled: editorDisabled, onClick: onReplace ?? (() => runCommand("editor.action.startFindReplaceAction")) },
          { label: "Workspace search", icon: "🔎", title: "Workspace search", disabled: !onWorkspaceFind, onClick: () => onWorkspaceFind?.() },
          { label: "Go to line", icon: "#", title: "Go to line", disabled: editorDisabled, onClick: () => runCommand("editor.action.gotoLine") },
          { label: "Go to symbol", icon: "◇", title: "Go to symbol", disabled: !onGoToSymbol, onClick: () => onGoToSymbol?.() },
        ]}
      />
      <ToolbarGroup
        label="Code actions"
        actions={[
          { label: "Toggle comment", icon: "//", title: "Toggle comment", disabled: editorDisabled, onClick: () => runCommand("editor.action.commentLine") },
          { label: "Format document", icon: "⎇", title: "Format document", disabled: editorDisabled, onClick: () => runAction("editor.action.formatDocument") },
          { label: "Fold all", icon: "⊟", title: "Fold all", disabled: editorDisabled, onClick: () => runAction("editor.foldAll") },
          { label: "Unfold all", icon: "⊞", title: "Unfold all", disabled: editorDisabled, onClick: () => runAction("editor.unfoldAll") },
          { label: "Settings", icon: "⚙", title: "Settings", disabled: !onSettings, onClick: () => onSettings?.() },
        ]}
      />
      <ToolbarGroup
        label="View actions"
        actions={[
          { label: "Toggle explorer", icon: "☰", title: "Toggle explorer", disabled: !onToggleExplorer, onClick: () => onToggleExplorer?.() },
          { label: "Split right", icon: "⇥", title: "Split right", disabled: !onSplitRight, onClick: () => onSplitRight?.() },
          { label: "Split down", icon: "⇩", title: "Split down", disabled: !onSplitDown, onClick: () => onSplitDown?.() },
          { label: "Detach pane", icon: "↗", title: "Detach pane", disabled: !onDetach, onClick: () => onDetach?.() },
          { label: "Problems", icon: "!", title: "Problems", disabled: !onProblems, onClick: () => onProblems?.() },
        ]}
      />
      <ToolbarGroup
        label="Run actions"
        actions={[
          { label: "Terminal", icon: "⌨", title: "Terminal", disabled: !onTerminal, onClick: () => onTerminal?.() },
          { label: "Assistant", icon: "🤖", title: "Assistant", disabled: !onAssistant, onClick: () => onAssistant?.() },
        ]}
      >
        {extraRunActions}
      </ToolbarGroup>
    </div>
  );
}

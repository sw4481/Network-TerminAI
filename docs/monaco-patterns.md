# Monaco Editor Patterns

**Source:** https://github.com/suren-atoyan/monaco-react  
**Version:** @monaco-editor/react@4.7.0  
**Date:** 2026-05-11

## Basic Usage

```typescript
import Editor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

function CodeEditor() {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    
    // Register keyboard shortcuts
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        console.log('Save triggered');
      }
    );
    
    // Track cursor position
    editor.onDidChangeCursorPosition((e) => {
      console.log('Cursor:', e.position.lineNumber, e.position.column);
    });
  };

  return (
    <Editor
      height="100%"
      language="python"
      value="print('hello')"
      onChange={(value) => console.log(value)}
      onMount={handleEditorDidMount}
      theme="vs-dark"
      options={{
        fontSize: 14,
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        formatOnPaste: true,
        formatOnType: true,
        suggestOnTriggerCharacters: true,
        quickSuggestions: true,
        parameterHints: { enabled: true },
        folding: true,
        lineNumbers: "on",
        renderWhitespace: "selection",
      }}
    />
  );
}
```

## Language Detection

```typescript
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  const languageMap: Record<string, string> = {
    'py': 'python',
    'js': 'javascript',
    'ts': 'typescript',
    'jsx': 'javascript',
    'tsx': 'typescript',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'tf': 'hcl',
    'md': 'markdown',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'toml': 'toml',
    'xml': 'xml',
    'html': 'html',
    'css': 'css',
    'rs': 'rust',
    'go': 'go',
  };
  
  return languageMap[ext || ''] || 'plaintext';
}
```

## Themes

- `vs` - Light theme
- `vs-dark` - Dark theme (default)
- `hc-black` - High contrast black

## Editor Options Schema

**Key Options:**
- `fontSize: number` - Font size (10-24)
- `fontFamily: string` - Font family
- `tabSize: number` - Tab size (2, 4, 8)
- `insertSpaces: boolean` - Use spaces instead of tabs
- `wordWrap: "on" | "off"` - Word wrapping
- `minimap: { enabled: boolean }` - Show minimap
- `lineNumbers: "on" | "off" | "relative"` - Line number display
- `renderWhitespace: "none" | "selection" | "all"` - Whitespace rendering
- `readOnly: boolean` - Read-only mode
- `automaticLayout: boolean` - Auto-resize on container change
- `scrollBeyondLastLine: boolean` - Allow scrolling past last line
- `quickSuggestions: boolean` - Auto-trigger suggestions
- `parameterHints: { enabled: boolean }` - Show parameter hints
- `folding: boolean` - Enable code folding

## External Value Updates

```typescript
// Update editor when external value changes
useEffect(() => {
  if (editorRef.current && editorRef.current.getValue() !== value) {
    editorRef.current.setValue(value);
  }
}, [value]);
```

## Common Patterns

**Save on Cmd+S:**
```typescript
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
  onSave();
});
```

**Focus editor:**
```typescript
editor.focus();
```

**Get/Set value:**
```typescript
const content = editor.getValue();
editor.setValue("new content");
```

**Get model:**
```typescript
const model = editor.getModel();
```

**Execute edits:**
```typescript
editor.executeEdits("source", [
  {
    range: new monaco.Range(1, 1, 1, 1),
    text: "inserted text",
  }
]);
```

## Verified Imports

```typescript
// Correct imports verified in package
import Editor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// Types available:
monaco.editor.IStandaloneCodeEditor
monaco.editor.ITextModel
monaco.IDisposable
monaco.languages.CompletionItemProvider
monaco.languages.HoverProvider
```

## Notes

- Monaco uses model URIs for identity (path-based)
- Each file should have unique URI
- Dispose providers when unmounting
- Use `automaticLayout: true` for responsive sizing
- Theme can be changed at runtime
- All keyboard shortcuts use KeyMod + KeyCode

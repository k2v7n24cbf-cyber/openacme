import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import CodeMirror, {
  EditorView,
  type Extension,
  type ViewUpdate,
} from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { linter, type Diagnostic } from "@codemirror/lint";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { cn } from "@/app/lib/utils";

const HOSTED_CODE_MIRROR_BASIC_SETUP_BASE = {
  lineNumbers: true,
  highlightActiveLineGutter: true,
  foldGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
  searchKeymap: true,
  foldKeymap: true,
  completionKeymap: true,
  lintKeymap: true,
} as const;

const HOSTED_CODE_MIRROR_THEME = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--code-surface)",
    color: "var(--ink)",
  },
  "&.cm-focused": {
    outline: "1px solid var(--plot-red)",
    outlineOffset: "-1px",
  },
  ".cm-scroller": {
    fontFamily:
      "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "12px",
    lineHeight: "20px",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "12px 0",
    caretColor: "var(--ink)",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  ".cm-line[data-hosted-code-editor-highlighted-line='true']": {
    backgroundColor: "color-mix(in oklch, var(--plot-red) 7%, transparent)",
    boxShadow: "inset 2px 0 0 var(--plot-red)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--paper-sunk)",
    borderRight: "1px solid var(--code-surface-rule)",
    color: "var(--ink-faint)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--plot-red) 6%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--plot-red) 8%, transparent)",
    color: "var(--ink-soft)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--plot-red) 20%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--code-surface)",
    border: "1px solid var(--code-surface-rule)",
    borderRadius: "0",
    color: "var(--ink-soft)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--code-surface)",
    border: "1px solid var(--code-surface-rule)",
    borderRadius: "0",
    color: "var(--ink)",
  },
});

export interface HostedCodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  textareaLabel?: string;
  path?: string;
  language: string;
  diagnostics?: HostedCodeEditorDiagnostic[];
  highlightedLineRange?: HostedCodeEditorLineRange;
  actions?: ReactNode;
  readOnly?: boolean;
  disabled?: boolean;
  minHeightClassName?: string;
}

export interface HostedCodeEditorDiagnostic {
  severity?: string;
  code?: string;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface HostedCodeEditorLineRange {
  startLine: number;
  endLine?: number;
}

export function HostedCodeEditor({
  value,
  onChange,
  label,
  textareaLabel,
  path,
  language,
  diagnostics = [],
  highlightedLineRange,
  actions,
  readOnly = false,
  disabled = false,
  minHeightClassName = "min-h-[420px]",
}: HostedCodeEditorProps) {
  const editorViewRef = useRef<EditorView | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const editable = Boolean(onChange) && !readOnly && !disabled;
  const lineCount = Math.max(1, value.split("\n").length);
  const editorMode = useMemo(
    () => hostedEditorLanguageMode({ language, path }),
    [language, path],
  );
  const editorExtensions = useMemo(
    () => hostedCodeMirrorExtensions(editorMode, diagnostics),
    [diagnostics, editorMode],
  );
  const basicSetup = useMemo(
    () => hostedCodeMirrorBasicSetupForMode(editorMode),
    [editorMode],
  );
  const normalizedHighlightedLineRange = useMemo(
    () => normalizeHostedCodeEditorLineRange(highlightedLineRange),
    [highlightedLineRange],
  );

  useEffect(() => {
    if (!editorViewRef.current) return;
    applyHostedCodeEditorLineRangeHighlight(
      editorViewRef.current.dom,
      normalizedHighlightedLineRange,
    );
  }, [normalizedHighlightedLineRange, value]);

  function updateCursor(update: ViewUpdate) {
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    const next = {
      line: line.number,
      column: head - line.from + 1,
    };
    setCursor((current) =>
      current.line === next.line && current.column === next.column
        ? current
        : next,
    );
  }

  return (
    <div
      data-hosted-code-editor-shell="true"
      data-hosted-code-editor-mode={editorMode}
      data-hosted-code-editor-state={
        readOnly || disabled ? "read-only" : "editable"
      }
      className="min-w-0 overflow-hidden border border-code-surface-rule bg-code-surface"
    >
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-paper-rule bg-paper-sunk px-3 py-2">
        <div className="min-w-0">
          <div className="label-faceplate text-ink-soft">{label}</div>
          {path && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
              {path}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          {actions}
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint tabular-nums">
            <span>{editorMode}</span>
            <span>{readOnly || disabled ? "read only" : "editable"}</span>
            {diagnostics.length > 0 ? (
              <span>
                {diagnostics.length}{" "}
                {diagnostics.length === 1 ? "diagnostic" : "diagnostics"}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className={cn("flex min-h-0 overflow-hidden", minHeightClassName)}>
        <CodeMirror
          value={value}
          readOnly={!editable}
          editable={editable}
          spellCheck={false}
          theme={HOSTED_CODE_MIRROR_THEME}
          extensions={editorExtensions}
          basicSetup={basicSetup}
          height="100%"
          width="100%"
          indentWithTab
          onChange={(nextValue) => {
            if (editable) onChange?.(nextValue);
          }}
          onUpdate={updateCursor}
          aria-label={textareaLabel ?? label}
          aria-disabled={disabled || undefined}
          onCreateEditor={(view) => {
            editorViewRef.current = view;
            applyHostedCodeEditorLineRangeHighlight(
              view.dom,
              normalizedHighlightedLineRange,
            );
          }}
          data-hosted-code-editor="codemirror"
          data-hosted-code-editor-diagnostic-count={diagnostics.length}
          className="min-w-0 flex-1"
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint tabular-nums">
        <span>
          {lineCount} lines · {value.length} chars
        </span>
        <span>
          ln {cursor.line}, col {cursor.column}
        </span>
      </div>
    </div>
  );
}

export function hostedCodeMirrorBasicSetupForMode(mode: string) {
  return {
    ...HOSTED_CODE_MIRROR_BASIC_SETUP_BASE,
    tabSize: mode === "python" ? 4 : 2,
  };
}

export function normalizeHostedCodeEditorLineRange(
  range: HostedCodeEditorLineRange | undefined,
): Required<HostedCodeEditorLineRange> | null {
  const startLine = positiveIntegerOrNull(range?.startLine);
  if (startLine === null) return null;
  const endLine = positiveIntegerOrNull(range?.endLine) ?? startLine;
  return {
    startLine,
    endLine: Math.max(startLine, endLine),
  };
}

export function applyHostedCodeEditorLineRangeHighlight(
  editorRoot: HTMLElement,
  range: Required<HostedCodeEditorLineRange> | null,
): number {
  const highlightedLines = editorRoot.querySelectorAll(
    "[data-hosted-code-editor-highlighted-line='true']",
  );
  highlightedLines.forEach((line) => {
    line.removeAttribute("data-hosted-code-editor-highlighted-line");
  });

  if (!range) return 0;

  let highlightedCount = 0;
  const lines = editorRoot.querySelectorAll<HTMLElement>(".cm-line");
  for (
    let lineNumber = range.startLine;
    lineNumber <= range.endLine && lineNumber <= lines.length;
    lineNumber += 1
  ) {
    const line = lines[lineNumber - 1];
    if (!line) continue;
    line.setAttribute("data-hosted-code-editor-highlighted-line", "true");
    highlightedCount += 1;
  }

  const firstHighlightedLine = lines[range.startLine - 1];
  if (typeof firstHighlightedLine?.scrollIntoView === "function") {
    firstHighlightedLine.scrollIntoView({ block: "center" });
  }

  return highlightedCount;
}

function hostedCodeMirrorExtensions(
  mode: string,
  diagnostics: HostedCodeEditorDiagnostic[],
): Extension[] {
  const extensions: Extension[] = [];
  if (mode === "python") extensions.push(python());
  if (mode === "json") extensions.push(json());
  if (mode === "yaml") extensions.push(yaml());
  if (diagnostics.length > 0) {
    extensions.push(
      linter(
        (view) =>
          hostedCodeMirrorDiagnosticsForDocument(view.state.doc, diagnostics),
        { delay: 0 },
      ),
    );
  }
  return extensions;
}

export function hostedEditorLanguageMode({
  language,
  path,
}: {
  language: string;
  path?: string;
}): string {
  const normalizedLanguage = language.toLowerCase();
  if (["python", "json", "yaml"].includes(normalizedLanguage)) {
    return normalizedLanguage;
  }
  if (path) return languageForHostedPath(path);
  return normalizedLanguage;
}

function languageForHostedPath(pathValue: string): string {
  const lower = pathValue.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "source";
}

interface HostedCodeMirrorDocumentLike {
  lines: number;
  line(lineNumber: number): {
    from: number;
    to: number;
    length: number;
  };
}

export function hostedCodeMirrorDiagnosticsForDocument(
  doc: HostedCodeMirrorDocumentLike,
  diagnostics: HostedCodeEditorDiagnostic[],
): Diagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    const lineNumber = positiveIntegerOrNull(diagnostic.line);
    if (lineNumber === null) return [];

    const clampedLineNumber = Math.min(lineNumber, doc.lines);
    const line = doc.line(clampedLineNumber);
    const startColumn = Math.min(
      positiveIntegerOrNull(diagnostic.column) ?? 1,
      line.length + 1,
    );
    const from = line.from + startColumn - 1;
    const endLineNumber =
      positiveIntegerOrNull(diagnostic.endLine) ?? clampedLineNumber;
    const clampedEndLineNumber = Math.min(endLineNumber, doc.lines);
    const endLine = doc.line(clampedEndLineNumber);
    const endColumn = Math.min(
      positiveIntegerOrNull(diagnostic.endColumn) ??
        (clampedEndLineNumber === clampedLineNumber
          ? startColumn + 1
          : endLine.length + 1),
      endLine.length + 1,
    );
    const rawTo = endLine.from + endColumn - 1;
    const to = Math.max(from + 1, rawTo);

    return [
      {
        from,
        to,
        severity: hostedCodeMirrorDiagnosticSeverity(diagnostic.severity),
        message: diagnostic.code
          ? `${diagnostic.code}: ${diagnostic.message}`
          : diagnostic.message,
      },
    ];
  });
}

function hostedCodeMirrorDiagnosticSeverity(
  severity: string | undefined,
): Diagnostic["severity"] {
  if (severity === "error") return "error";
  if (severity === "info") return "info";
  return "warning";
}

function positiveIntegerOrNull(value: number | undefined): number | null {
  if (!Number.isInteger(value) || value === undefined || value < 1) return null;
  return value;
}

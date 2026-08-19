// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHostedIntegrationEditorModel,
  type HostedIntegrationAdminFamilyRow,
} from "@/app/lib/hosted-integrations-admin";
import {
  applyHostedCodeEditorLineRangeHighlight,
  HostedCodeEditor,
  hostedCodeMirrorBasicSetupForMode,
  hostedCodeMirrorDiagnosticsForDocument,
  hostedEditorLanguageMode,
  normalizeHostedCodeEditorLineRange,
} from "@/app/components/hosted/HostedCodeEditor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function renderHostedCodeEditor(
  props: ComponentProps<typeof HostedCodeEditor>,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(HostedCodeEditor, props));
  });
  return container;
}

function documentLike(value: string) {
  const lines = value.split("\n");
  const starts = lines.reduce<number[]>((acc, line, index) => {
    acc.push(index === 0 ? 0 : acc[index - 1]! + lines[index - 1]!.length + 1);
    return acc;
  }, []);
  return {
    lines: lines.length,
    line(lineNumber: number) {
      const index = lineNumber - 1;
      const from = starts[index] ?? 0;
      const line = lines[index] ?? "";
      return {
        from,
        to: from + line.length,
        length: line.length,
      };
    },
  };
}

describe("hosted integrations rich editor model", () => {
  it("renders hosted code through the CodeMirror adapter without a textarea fallback", () => {
    const onChange = vi.fn();
    const view = renderHostedCodeEditor({
      label: "Handler source",
      textareaLabel: "Python handler source",
      language: "python",
      path: "qualys.py",
      value: "def tool(args, context):\n    return {}",
      onChange,
    });

    expect(
      view.querySelector('[data-hosted-code-editor="codemirror"]'),
    ).not.toBeNull();
    const shell = view.querySelector('[data-hosted-code-editor-shell="true"]');
    expect(shell?.getAttribute("data-hosted-code-editor-mode")).toBe("python");
    expect(shell?.getAttribute("data-hosted-code-editor-state")).toBe(
      "editable",
    );
    expect(shell?.className).toContain("bg-code-surface");
    expect(shell?.className).toContain("border-code-surface-rule");
    expect(view.querySelector("textarea")).toBeNull();
    expect(
      view.querySelector(".cm-content")?.getAttribute("contenteditable"),
    ).toBe("true");
    expect(view.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(view.querySelector(".cm-foldGutter")).not.toBeNull();
    expect(view.textContent).toContain("python");
    expect(view.textContent).toContain("editable");
    expect(view.textContent).toContain("2 lines");
  });

  it("uses the Python editor baseline for explicit Python and .py paths", () => {
    expect(
      hostedEditorLanguageMode({ language: "python", path: "family.txt" }),
    ).toBe("python");
    expect(
      hostedEditorLanguageMode({ language: "source", path: "qualys.py" }),
    ).toBe("python");
    expect(hostedCodeMirrorBasicSetupForMode("python").tabSize).toBe(4);
    expect(hostedCodeMirrorBasicSetupForMode("json").tabSize).toBe(2);
  });

  it("uses JSON and YAML modes for hosted payload and package surfaces", () => {
    expect(hostedEditorLanguageMode({ language: "json" })).toBe("json");
    expect(
      hostedEditorLanguageMode({ language: "source", path: "tools.yaml" }),
    ).toBe("yaml");
    expect(
      hostedEditorLanguageMode({ language: "source", path: "family.yml" }),
    ).toBe("yaml");
    expect(
      hostedEditorLanguageMode({ language: "source", path: "handler.py" }),
    ).toBe("python");
    expect(hostedCodeMirrorBasicSetupForMode("yaml").tabSize).toBe(2);
  });

  it("renders JSON and YAML through the same CodeMirror adapter", () => {
    const jsonView = renderHostedCodeEditor({
      label: "Debug arguments",
      language: "json",
      value: '{\n  "limit": 1\n}',
      onChange: vi.fn(),
    });

    expect(jsonView.querySelector("textarea")).toBeNull();
    expect(jsonView.textContent).toContain("json");
    expect(jsonView.querySelector(".cm-content")?.textContent).toContain(
      '"limit"',
    );

    act(() => root?.unmount());
    root = null;
    jsonView.remove();
    container = null;

    const yamlView = renderHostedCodeEditor({
      label: "Package tools",
      language: "source",
      path: "tools.yaml",
      value: "tools:\n  - name: qualys_count_assets",
      readOnly: true,
    });

    expect(yamlView.querySelector("textarea")).toBeNull();
    expect(yamlView.textContent).toContain("yaml");
    expect(yamlView.querySelector(".cm-content")?.textContent).toContain(
      "qualys_count_assets",
    );
  });

  it("renders read-only hosted code without exposing an editable content surface", () => {
    const view = renderHostedCodeEditor({
      label: "Handler source",
      textareaLabel: "Read-only Python handler source",
      language: "python",
      value: "def tool(args, context):\n    return {}",
      diagnostics: [
        {
          severity: "warning",
          code: "structured_hook_missing",
          message: "post_tool_call hook is not defined.",
          line: 2,
          column: 5,
        },
      ],
      readOnly: true,
    });

    expect(view.textContent).toContain("read only");
    expect(
      view
        .querySelector('[data-hosted-code-editor-shell="true"]')
        ?.getAttribute("data-hosted-code-editor-state"),
    ).toBe("read-only");
    expect(view.textContent).toContain("1 diagnostic");
    expect(
      view
        .querySelector('[data-hosted-code-editor="codemirror"]')
        ?.getAttribute("data-hosted-code-editor-diagnostic-count"),
    ).toBe("1");
    expect(
      view.querySelector(".cm-content")?.getAttribute("contenteditable"),
    ).toBe("false");
  });

  it("maps only line-targeted source diagnostics into CodeMirror diagnostics", () => {
    const diagnostics = hostedCodeMirrorDiagnosticsForDocument(
      documentLike("def tool(args, context):\n    return {}"),
      [
        {
          severity: "error",
          code: "bad_handler",
          message: "Handler did not match the manifest.",
          line: 2,
          column: 5,
          endColumn: 11,
        },
        {
          severity: "warning",
          code: "family_notice",
          message: "Full-family source has limited visibility.",
        },
      ],
    );

    expect(diagnostics).toEqual([
      {
        from: 29,
        to: 35,
        severity: "error",
        message: "bad_handler: Handler did not match the manifest.",
      },
    ]);
  });

  it("highlights the selected handler line range without hiding full source", () => {
    const view = renderHostedCodeEditor({
      label: "Handler source",
      language: "python",
      value:
        "def helper():\n    return None\n\ndef tool(args, context):\n    return {}",
      highlightedLineRange: { startLine: 4, endLine: 5 },
      readOnly: true,
    });

    const highlightedLines = view.querySelectorAll(
      "[data-hosted-code-editor-highlighted-line='true']",
    );
    expect(highlightedLines).toHaveLength(2);
    expect(highlightedLines[0]?.textContent).toContain("def tool");
    expect(highlightedLines[1]?.textContent).toContain("return {}");
  });

  it("normalizes selected handler line ranges before applying DOM highlights", () => {
    const editorRoot = document.createElement("div");
    editorRoot.innerHTML =
      '<div class="cm-line">one</div><div class="cm-line">two</div>';

    expect(normalizeHostedCodeEditorLineRange(undefined)).toBeNull();
    expect(
      normalizeHostedCodeEditorLineRange({ startLine: 2, endLine: 1 }),
    ).toEqual({ startLine: 2, endLine: 2 });
    expect(
      applyHostedCodeEditorLineRangeHighlight(editorRoot, {
        startLine: 2,
        endLine: 2,
      }),
    ).toBe(1);
    expect(
      editorRoot
        .querySelectorAll(".cm-line")[1]
        ?.getAttribute("data-hosted-code-editor-highlighted-line"),
    ).toBe("true");
    expect(applyHostedCodeEditorLineRangeHighlight(editorRoot, null)).toBe(0);
    expect(
      editorRoot.querySelector(
        "[data-hosted-code-editor-highlighted-line='true']",
      ),
    ).toBeNull();
  });

  it("focuses the selected tool handler and keeps unrelated handlers collapsed", () => {
    const row: HostedIntegrationAdminFamilyRow = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: {
        id: "gen_2",
        familyId: "qualys",
        sourceRevisionId: "source_rev_2",
        status: "active",
        promotedAt: "2026-08-12T00:00:00.000Z",
        promotedBy: "agent:tool-developer",
      },
      tools: [
        {
          name: "qualys_count_assets",
          title: "Count assets",
          description: "Count assets.",
          lifecycle: "active",
          inputSchema: { type: "object" },
          help: { summary: "Count help." },
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
        },
        {
          name: "qualys_search_assets",
          title: "Search assets",
          description: "Search assets.",
          lifecycle: "active",
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
        },
      ],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: {
        id: "lock_1",
        familyId: "qualys",
        lockedBy: "web-settings",
        expiresAt: "2026-08-12T01:00:00.000Z",
      },
    };

    const model = buildHostedIntegrationEditorModel({
      row,
      selectedToolName: "qualys_count_assets",
      lock: row.lock,
      actorId: "web-settings",
      sourceView: {
        mode: "focused",
        manifest: { tool: row.tools[0]! },
        source: {
          selectedHandler: {
            name: "tool_qualys_count_assets",
            startLine: 5,
            endLine: 6,
            source:
              "def tool_qualys_count_assets(args, context):\n    return {}",
          },
          hooks: [],
          helpers: [],
          collapsedToolHandlers: [
            {
              toolName: "qualys_search_assets",
              functionName: "tool_qualys_search_assets",
              source: "def tool_qualys_search_assets(...):",
            },
          ],
        },
        diagnostics: [],
      },
    });

    expect(model).toMatchObject({
      selectedHandlerName: "tool_qualys_count_assets",
      helpSummary: "Count help.",
      inputSchema: { type: "object" },
      canManage: true,
      canEdit: true,
      canRunReadSafeDebug: true,
      collapsedHandlerNames: ["tool_qualys_search_assets"],
      focusedHandlerCode: expect.stringContaining(
        "def tool_qualys_count_assets",
      ),
    });
  });

  it("disables edit and debug controls for humans without management permission", () => {
    const row: HostedIntegrationAdminFamilyRow = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: null,
      tools: [
        {
          name: "qualys_count_assets",
          title: "Count assets",
          description: "Count assets.",
          lifecycle: "active",
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
        },
      ],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: {
        id: "lock_1",
        familyId: "qualys",
        lockedBy: "web-settings",
        expiresAt: "2026-08-12T01:00:00.000Z",
      },
    };

    const model = buildHostedIntegrationEditorModel({
      row,
      selectedToolName: "qualys_count_assets",
      lock: row.lock,
      actorId: "web-settings",
      actorCanManage: false,
      sourceView: null,
    });

    expect(model).toMatchObject({
      canManage: false,
      canEdit: false,
      canRunReadSafeDebug: false,
    });
  });
});

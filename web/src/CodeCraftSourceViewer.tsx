/**
 * Adapted from Seeed-Studio/CodeCraft gui/src/lib/code-editor/code-editor.js
 * commit d236f3c59d33639e0006a80f2dac931ee05956fd (BSD-3-Clause).
 * Copyright (c) 2016, Massachusetts Institute of Technology. All rights reserved.
 * See public/CodeCraft-code-editor-LICENSE.txt and CodeCraft-code-editor-NOTICE.txt.
 * AE changes: instance ownership, lazy local ESM/worker, React lifecycle, file
 * languages, accessible search, resize cleanup and a readable failure fallback.
 */
import { useEffect, useId, useRef, useState } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api";
import { useI18n } from "./i18n";
import "./codeCraftSourceViewer.css";

type Props = { content: string; path: string };
type MonacoApi = typeof Monaco;
let apiPromise: Promise<MonacoApi> | undefined;

function loadEditor(): Promise<MonacoApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const [{ default: EditorWorker }, monaco] = await Promise.all([
        import("monaco-editor/editor/editor.worker.js?worker"),
        import("monaco-editor/editor/editor.api"),
      ]);
      // Vite emits this worker beside the app assets, including under /AE/ Pages.
      (
        globalThis as typeof globalThis & {
          MonacoEnvironment?: { getWorker: () => Worker };
        }
      ).MonacoEnvironment = { getWorker: () => new EditorWorker() };
      await Promise.all([
        import("monaco-editor/features/codicon/register"),
        import("monaco-editor/features/find/register"),
        import("monaco-editor/features/clipboard/register"),
        import("monaco-editor/features/contextmenu/register"),
        import("monaco-editor/languages/definitions/cpp/register"),
        import("monaco-editor/languages/definitions/python/register"),
        import("monaco-editor/languages/definitions/markdown/register"),
        import("monaco-editor/languages/definitions/xml/register"),
        import("monaco-editor/languages/definitions/yaml/register"),
        import("monaco-editor/languages/definitions/shell/register"),
        import("monaco-editor/languages/definitions/ini/register"),
        import("monaco-editor/languages/definitions/javascript/register"),
        import("monaco-editor/languages/definitions/typescript/register"),
        import("monaco-editor/languages/definitions/css/register"),
        import("monaco-editor/languages/definitions/html/register"),
      ]);
      // Syntax only: no JSON schema fetching, diagnostics service or TS worker.
      monaco.languages.register({ id: "ae-json", aliases: ["JSON"] });
      monaco.languages.setMonarchTokensProvider("ae-json", {
        tokenizer: {
          root: [
            [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type.identifier"],
            [/"(?:[^"\\]|\\.)*"/, "string"],
            [/\b(?:true|false|null)\b/, "keyword"],
            [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
            [/[{}\[\],:]/, "delimiter"],
          ],
        },
      });
      return monaco;
    })().catch((error: unknown) => {
      apiPromise = undefined;
      throw error;
    });
  }
  return apiPromise;
}

function languageForPath(path: string): [string, string] {
  const name = path.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  const extension = name.split(".").pop() ?? "";
  if (["ino", "cpp", "cc", "cxx", "h", "hpp", "hxx"].includes(extension))
    return ["cpp", "C++ / Arduino"];
  if (extension === "c") return ["c", "C"];
  if (extension === "py") return ["python", "Python"];
  if (["json", "jsonl"].includes(extension)) return ["ae-json", "JSON"];
  if (["md", "markdown"].includes(extension)) return ["markdown", "Markdown"];
  if (["xml", "urdf", "sdf", "xacro", "launch"].includes(extension))
    return ["xml", "XML"];
  if (["yaml", "yml"].includes(extension)) return ["yaml", "YAML"];
  if (["sh", "bash"].includes(extension)) return ["shell", "Shell"];
  if (["ini", "cfg", "conf", "toml"].includes(extension))
    return ["ini", "Configuration"];
  if (["js", "jsx", "mjs", "cjs"].includes(extension))
    return ["javascript", "JavaScript"];
  if (["ts", "tsx"].includes(extension)) return ["typescript", "TypeScript"];
  if (extension === "css") return ["css", "CSS"];
  if (["html", "htm"].includes(extension)) return ["html", "HTML"];
  return ["plaintext", "Text"];
}

/** CodeCraft's model/setValue/setLanguage wrapper, owned by one React instance. */
class CodeCraftReadOnlyEditor {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  private model: Monaco.editor.ITextModel;

  constructor(
    private monaco: MonacoApi,
    element: HTMLElement,
    content: string,
    language: string,
    ariaLabel: string,
  ) {
    this.model = monaco.editor.createModel(content, language);
    this.editor = monaco.editor.create(element, {
      model: this.model,
      theme: "vs",
      autoIndent: "full",
      formatOnPaste: false,
      automaticLayout: false,
      guides: { highlightActiveIndentation: false },
      lineNumbers: "on",
      links: false,
      lineHeight: 23,
      fontSize: 13,
      matchBrackets: "never",
      minimap: { enabled: false },
      overviewRulerBorder: false,
      readOnly: true,
      domReadOnly: true,
      wordWrap: "on",
      wrappingIndent: "none",
      scrollbar: { verticalHasArrows: true, verticalScrollbarSize: 8 },
      scrollBeyondLastLine: false,
      ariaLabel,
      accessibilitySupport: "on",
      tabFocusMode: true,
      tabIndex: 0,
      renderValidationDecorations: "off",
      padding: { top: 12, bottom: 12 },
    });
  }

  setValue(value: string) {
    if (this.model.getValue() !== value) this.model.setValue(value);
  }

  setLanguage(language: string) {
    this.monaco.editor.setModelLanguage(this.model, language);
  }

  setFile(content: string, language: string) {
    const old = this.model;
    this.model = this.monaco.editor.createModel(content, language);
    this.editor.setModel(this.model);
    old.dispose();
  }

  dispose() {
    this.editor.dispose();
    this.model.dispose();
  }
}

export default function CodeCraftSourceViewer({ content, path }: Props) {
  const { t, locale } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<CodeCraftReadOnlyEditor | null>(null);
  const current = useRef({ content, path });
  current.current = { content, path };
  const displayedPath = useRef(path);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const hintId = useId();
  const [, label] = languageForPath(path);

  useEffect(() => {
    let active = true;
    let observer: ResizeObserver | undefined;
    let owned: CodeCraftReadOnlyEditor | undefined;
    let frame = 0;
    void loadEditor()
      .then((api) => {
        if (!active || !host.current) return;
        const file = current.current;
        owned = new CodeCraftReadOnlyEditor(
          api,
          host.current,
          file.content,
          languageForPath(file.path)[0],
          file.path,
        );
        instance.current = owned;
        displayedPath.current = file.path;
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            if (active && host.current)
              owned?.editor.layout({
                width: host.current.clientWidth,
                height: host.current.clientHeight,
              });
          });
        });
        observer.observe(host.current);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("failed");
      });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      owned?.dispose();
      if (instance.current === owned) instance.current = null;
    };
  }, []);

  useEffect(() => {
    const view = instance.current;
    if (!view) return;
    if (displayedPath.current !== path) {
      view.setFile(content, languageForPath(path)[0]);
      displayedPath.current = path;
    } else {
      view.setValue(content);
      view.setLanguage(languageForPath(path)[0]);
    }
    view.editor.updateOptions({
      ariaLabel: t(`只读代码：${path}`, `Read-only source: ${path}`),
    });
  }, [content, path, locale, state, t]);

  return (
    <div className="cc-source-viewer">
      <div className="cc-source-toolbar">
        <span>
          {t("代码预览", "Source preview")}{" "}
          <b>
            {label === "Text"
              ? t("纯文本", "Text")
              : label === "Configuration"
                ? t("配置文件", "Configuration")
                : label}
          </b>
        </span>
        <button
          type="button"
          disabled={state !== "ready"}
          onClick={() => {
            instance.current?.editor.focus();
            void instance.current?.editor.getAction("actions.find")?.run();
          }}
        >
          {t("查找", "Find")} <kbd>Ctrl/⌘ F</kbd>
        </button>
      </div>
      <p id={hintId} className="cc-source-hint">
        {t(
          "只读文件 · 内容不会在这里被修改。按 Esc 关闭查找；按 Tab 移出代码区。",
          "Read-only file. Escape closes Find; Tab moves out of the source pane.",
        )}
      </p>
      <div className="cc-source-body" aria-describedby={hintId}>
        <div
          ref={host}
          className="cc-source-editor"
          style={{ visibility: state === "ready" ? "visible" : "hidden" }}
        />
        {state !== "ready" && (
          <div className="cc-source-fallback">
            <p role="status">
              {state === "loading"
                ? t("正在加载代码阅读器…", "Loading source viewer…")
                : t(
                    "高亮阅读器未能加载，以下仍可查看完整文件。",
                    "Syntax viewer could not load. The full file is available below.",
                  )}
            </p>
            <pre
              tabIndex={0}
              aria-label={t(`只读代码：${path}`, `Read-only source: ${path}`)}
            >
              {content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

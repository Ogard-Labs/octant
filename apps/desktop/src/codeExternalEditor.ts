import type { SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";

export interface CodeExternalEditorConfiguration {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
}

export interface CodeExternalEditorTarget {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

interface SpawnedEditor {
  readonly unref?: () => void;
}

type SpawnEditor = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedEditor;

interface OpaqueEditorRequest {
  readonly threadId: string;
  readonly checkoutId: string;
  readonly fileId: string;
  readonly line: number;
  readonly column: number;
}

export async function openCodeExternalEditorFromServer(options: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowId: string;
  readonly request: OpaqueEditorRequest;
  readonly fetch: typeof globalThis.fetch;
  readonly spawn: SpawnEditor;
}): Promise<void> {
  try {
    const response = await options.fetch(
      new URL("/api/desktop/code-external-editor-target", options.serverUrl).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": options.desktopBridgeSecret,
        },
        body: JSON.stringify({ windowId: options.windowId, ...options.request }),
      },
    );
    if (!response.ok) throw new Error("unavailable");
    const target = decodeTarget(await response.json());
    await launchCodeExternalEditor({ editor: target.editor, target, spawn: options.spawn });
  } catch {
    throw new Error("Octant could not open the configured external editor.");
  }
}

export async function launchCodeExternalEditor(options: {
  readonly editor: CodeExternalEditorConfiguration;
  readonly target: CodeExternalEditorTarget;
  readonly spawn: SpawnEditor;
}): Promise<void> {
  validate(options.editor, options.target);
  const values = {
    file: options.target.file,
    line: String(options.target.line),
    column: String(options.target.column),
  } as const;
  const arguments_ = options.editor.arguments.map((argument) =>
    argument.replaceAll(
      /\{(file|line|column)\}/g,
      (_match, key: keyof typeof values) => values[key],
    ),
  );
  try {
    options
      .spawn(options.editor.executable, arguments_, {
        detached: true,
        shell: false,
        stdio: "ignore",
      })
      .unref?.();
  } catch {
    throw new Error("Octant could not open the configured external editor.");
  }
}

function validate(editor: CodeExternalEditorConfiguration, target: CodeExternalEditorTarget): void {
  const invalidArgument = editor.arguments.some(
    (argument) => argument.includes("\0") || /\{(?!file\}|line\}|column\})[^}]*\}/.test(argument),
  );
  if (
    !isAbsolute(editor.executable) ||
    editor.executable.includes("\0") ||
    editor.arguments.length > 32 ||
    invalidArgument ||
    !isAbsolute(target.file) ||
    target.file.includes("\0") ||
    !Number.isSafeInteger(target.line) ||
    target.line < 1 ||
    !Number.isSafeInteger(target.column) ||
    target.column < 1
  ) {
    throw new TypeError("Octant rejected an invalid external editor request.");
  }
}

function decodeTarget(value: unknown): CodeExternalEditorTarget & {
  readonly editor: CodeExternalEditorConfiguration;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid");
  const target = value as Record<string, unknown>;
  const editor = target.editor;
  if (
    Object.keys(target).sort().join("\0") !==
      ["file", "line", "column", "editor"].sort().join("\0") ||
    typeof target.file !== "string" ||
    typeof target.line !== "number" ||
    typeof target.column !== "number" ||
    typeof editor !== "object" ||
    editor === null ||
    Array.isArray(editor)
  )
    throw new Error("invalid");
  const record = editor as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== ["executable", "arguments"].sort().join("\0") ||
    typeof record.executable !== "string" ||
    !Array.isArray(record.arguments) ||
    !record.arguments.every((argument) => typeof argument === "string")
  )
    throw new Error("invalid");
  return {
    file: target.file,
    line: target.line,
    column: target.column,
    editor: { executable: record.executable, arguments: record.arguments as string[] },
  };
}

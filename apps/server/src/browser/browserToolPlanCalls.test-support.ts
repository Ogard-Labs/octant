import type {
  BrowserToolOperationName,
  BrowserToolRecordingOperation,
} from "./browserToolOperations";

/**
 * One well-formed call of every advertised Browser operation, keyed like
 * `BROWSER_OPERATION_EFFECT`, so a new operation does not compile until the
 * Plan tests of Work and Code exercise it too. The model never names the two
 * recording operations; a call with `record` makes the host issue them.
 */
export const BROWSER_CALL_OF_EACH_OPERATION = {
  snapshot: { operation: "snapshot" },
  "read-page": { operation: "read-page", selector: "h1" },
  screenshot: { operation: "screenshot" },
  diagnostics: { operation: "diagnostics" },
  audit: { operation: "audit", kind: "accessibility" },
  "tab-list": { operation: "tab-list" },
  wait: { operation: "wait", selector: "main" },
  "flow-list": { operation: "flow-list" },
  help: { operation: "help" },
  stop: { operation: "stop" },
  steps: { operation: "steps", steps: [{ operation: "snapshot" }] },
  navigate: { operation: "navigate", url: "https://example.com/next" },
  click: { operation: "click", ref: "e1" },
  type: { operation: "type", ref: "e1", text: "Ada" },
  press: { operation: "press", key: "Enter" },
  select: { operation: "select", ref: "e1", value: "a" },
  drag: { operation: "drag", ref: "e1", toRef: "e2" },
  hover: { operation: "hover", ref: "e1" },
  scroll: { operation: "scroll", deltaY: 200 },
  resize: { operation: "resize", preset: "phone" },
  upload: { operation: "upload", ref: "e1", files: ["notes.txt"] },
  "download-save": { operation: "download-save", downloadId: "d1" },
  "tab-open": { operation: "tab-open" },
  "tab-close": { operation: "tab-close", tabId: "t1" },
  "tab-switch": { operation: "tab-switch", tabId: "t1" },
  "sign-in": { operation: "sign-in", reason: "The page needs a sign-in." },
  "run-script": { operation: "run-script", source: "1", expectedObservationRevision: 0 },
  "flow-save": { operation: "flow-save", name: "Order check" },
  "flow-run": { operation: "flow-run", name: "Order check" },
  "record-start": { operation: "steps", record: true, steps: [{ operation: "snapshot" }] },
  "record-stop": { operation: "flow-run", name: "Order check", record: true },
} as const satisfies Record<
  BrowserToolOperationName | BrowserToolRecordingOperation,
  { readonly operation: string; readonly [field: string]: unknown }
>;

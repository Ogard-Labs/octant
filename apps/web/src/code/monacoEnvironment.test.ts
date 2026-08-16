import { describe, expect, it, vi } from "vitest";
import {
  createMonacoEnvironment,
  installMonacoEnvironment,
  monacoWorkerKindForLabel,
} from "./monacoEnvironment";

describe("Monaco Code-only worker environment", () => {
  it.each([
    ["json", "json"],
    ["css", "css"],
    ["scss", "css"],
    ["less", "css"],
    ["html", "html"],
    ["handlebars", "html"],
    ["razor", "html"],
    ["typescript", "typescript"],
    ["javascript", "typescript"],
    ["unknown", "editor"],
  ] as const)("maps %s to the %s worker", (label, expected) => {
    expect(monacoWorkerKindForLabel(label)).toBe(expected);
  });

  it("installs one explicit worker router and replaces stale global authority", () => {
    const workers = {
      css: vi.fn(() => ({ kind: "css" }) as never),
      editor: vi.fn(() => ({ kind: "editor" }) as never),
      html: vi.fn(() => ({ kind: "html" }) as never),
      json: vi.fn(() => ({ kind: "json" }) as never),
      typescript: vi.fn(() => ({ kind: "typescript" }) as never),
    };
    const target = { MonacoEnvironment: { stale: true } } as unknown as {
      MonacoEnvironment?: {
        readonly getWorker: (moduleId: string, label: string) => Promise<Worker> | Worker;
      };
    };

    installMonacoEnvironment(target, workers);
    const environment = createMonacoEnvironment(workers);

    expect(target.MonacoEnvironment).toEqual(
      expect.objectContaining({ getWorker: expect.any(Function) }),
    );
    expect(environment.getWorker("", "typescript")).toEqual({ kind: "typescript" });
    expect(environment.getWorker("", "json")).toEqual({ kind: "json" });
    expect(workers.typescript).toHaveBeenCalledOnce();
    expect(workers.json).toHaveBeenCalledOnce();
  });
});

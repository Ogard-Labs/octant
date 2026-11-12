import { afterEach, expect, it, vi } from "vitest";
import { writeDiagnostic } from "./diagnosticLog";

afterEach(() => vi.restoreAllMocks());

it("swallows a write that fails on a closed pipe", () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("EPIPE");
  });

  expect(() => writeDiagnostic("Octant could not start: reason")).not.toThrow();
});

it("keeps an asynchronous stream error from becoming an uncaught exception", () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  writeDiagnostic("reason");

  expect(() => process.stderr.emit("error", new Error("EPIPE"))).not.toThrow();
});

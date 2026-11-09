import { Worker } from "node:worker_threads";
import type { BenchmarkPatternMatcher } from "@octant/domain";

/** How long one pattern may run against one answer. */
export const BENCHMARK_PATTERN_DEADLINE_MS = 2_000;

// The worker holds nothing but the regular expression, so a pattern that never
// returns costs a thread that is terminated, never the host's event loop.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const matched = new RegExp(workerData.pattern, workerData.flags).test(workerData.text);
  parentPort.postMessage({ matched });
} catch {
  parentPort.postMessage({ refused: "invalid pattern" });
}
`;

/**
 * Tests a hand-written pattern in a worker thread under a deadline. A pattern
 * such as `(a+)+$` can take longer than the age of the host on a short answer;
 * on timeout the worker is terminated and the check fails with a reason.
 */
export function createWorkerPatternMatcher(
  deadlineMs: number = BENCHMARK_PATTERN_DEADLINE_MS,
): BenchmarkPatternMatcher {
  return (pattern, flags, text) =>
    new Promise((resolve) => {
      let done = false;
      let worker: Worker | undefined;
      const finish = (outcome: Awaited<ReturnType<BenchmarkPatternMatcher>>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void worker?.terminate();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ refused: "pattern took too long" }), deadlineMs);
      try {
        worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags, text } });
      } catch {
        finish({ refused: "pattern could not be tested" });
        return;
      }
      worker.once("message", (message: unknown) => {
        if (typeof message === "object" && message !== null) {
          if ("matched" in message && typeof message.matched === "boolean") {
            finish({ matched: message.matched });
            return;
          }
          if ("refused" in message && typeof message.refused === "string") {
            finish({ refused: message.refused });
            return;
          }
        }
        finish({ refused: "pattern could not be tested" });
      });
      worker.once("error", () => finish({ refused: "pattern could not be tested" }));
      worker.once("exit", () => finish({ refused: "pattern could not be tested" }));
    });
}

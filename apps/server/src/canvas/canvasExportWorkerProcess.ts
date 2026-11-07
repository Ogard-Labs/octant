import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  CANVAS_EXPORT_WORKER_MESSAGE_BYTES,
  CANVAS_EXPORT_WORKER_REQUEST_BYTES,
  CanvasExportWorkerMessage,
  CanvasExportWorkerRequest,
} from "@octant/plugin-api/canvas-export-worker";
import type { CanvasExportDestination } from "@octant/plugin-api/canvas-export";
import type { CanvasExportRenderedOutput } from "@octant/contracts/canvas-export";
import type {
  ExtensionVersionReference,
  ExtensionPackageStore,
} from "../extensions/extensionPackageStore";
import type { ExtensionSupervisor, OutsideDriverRuntime } from "../extensions/extensionSupervisor";
import { canvasExportWorkerFetch } from "./canvasExportWorkerFetch";

const decodeMessage = Schema.decodeUnknownSync(CanvasExportWorkerMessage);
const decodeRequest = Schema.decodeUnknownSync(CanvasExportWorkerRequest);
export interface CanvasExportWorkerProcessOptions {
  readonly store: Pick<ExtensionPackageStore, "verifiedModuleEntry">;
  readonly supervisor: Pick<ExtensionSupervisor, "startInteractive"> | undefined;
  readonly runtime: OutsideDriverRuntime | undefined;
  readonly workerEntryPoint: string;
  readonly platform: NodeJS.Platform;
}

/** One finite invocation, with no persistent plugin process or payload cache. */
export async function runCanvasExportWorker(
  options: CanvasExportWorkerProcessOptions,
  input: {
    readonly reference: ExtensionVersionReference;
    readonly componentId: string;
    readonly current: () => boolean;
    readonly allowedOrigins: ReadonlyArray<string>;
    readonly phase: "describe" | "export";
    readonly output: CanvasExportRenderedOutput;
    readonly confirmed?: CanvasExportDestination;
  },
): Promise<CanvasExportWorkerMessage> {
  const request = decodeRequest({
    protocol: "canvas-export/1",
    phase: input.phase,
    output: input.output,
    ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
  });
  const serializedRequest = JSON.stringify(request);
  const failed = { kind: "failed" } as const;
  if (Buffer.byteLength(serializedRequest) > CANVAS_EXPORT_WORKER_REQUEST_BYTES) return failed;
  const runtime = options.runtime;
  const supervisor = options.supervisor;
  if (
    options.platform !== "darwin" ||
    supervisor === undefined ||
    runtime === undefined ||
    !input.current()
  )
    return failed;
  const entry = await options.store.verifiedModuleEntry(
    input.reference,
    input.componentId,
    "canvas-export-target",
  );
  if (entry === undefined || !input.current()) return failed;
  const temporaryDirectory = await mkdtemp(join(await realpath(tmpdir()), "octant-export-worker-"));
  const controller = new AbortController();
  let stop: (() => Promise<void>) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let authorityPoll: ReturnType<typeof setInterval> | undefined;
  const requests = new Set<Promise<void>>();
  try {
    if (!input.current()) return failed;
    const started = await supervisor.startInteractive(
      {
        ...input.reference,
        componentId: input.componentId,
        entryPoint: entry.entryPoint,
        command: runtime.path,
        args: [options.workerEntryPoint, entry.entryPoint],
        cwd: entry.packageRoot,
        env: {},
        effective: true,
        approved: true,
        authority: { kind: "trusted-extension", extensionId: input.reference.extensionId },
        sandbox: {
          kind: "canvas-export",
          runtime: runtime.kind,
          instanceId: randomUUID(),
          packageRoot: entry.packageRoot,
          temporaryDirectory,
          workerEntryPoint: options.workerEntryPoint,
        },
      },
      controller.signal,
    );
    stop = started.process.stop;
    const stdin = started.process.stdin;
    const stdout = started.process.stdout;
    if (stdin === undefined || stdout === undefined || !input.current()) return failed;
    return await new Promise<CanvasExportWorkerMessage>((resolve) => {
      let finished = false;
      let buffer = "";
      let totalBytes = 0;
      const seen = new Set<number>();
      const finish = (value: CanvasExportWorkerMessage) => {
        if (finished) return;
        finished = true;
        controller.abort();
        resolve(value);
      };
      const send = (value: unknown) => {
        if (!finished && !stdin.destroyed) stdin.write(`${JSON.stringify(value)}\n`);
      };
      deadline = setTimeout(() => finish(failed), input.phase === "describe" ? 8000 : 30000);
      authorityPoll = setInterval(() => {
        if (!input.current()) finish(failed);
      }, 100);
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        if (finished) return;
        totalBytes += Buffer.byteLength(chunk);
        buffer += chunk;
        if (
          totalBytes > CANVAS_EXPORT_WORKER_MESSAGE_BYTES * 2 ||
          Buffer.byteLength(buffer) > CANVAS_EXPORT_WORKER_MESSAGE_BYTES
        ) {
          finish(failed);
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0 && !finished) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: CanvasExportWorkerMessage;
          try {
            message = decodeMessage(JSON.parse(line));
          } catch {
            finish(failed);
            return;
          }
          if (!input.current()) {
            finish(failed);
            return;
          }
          if (message.kind !== "fetch") {
            finish(
              (input.phase === "describe" && message.kind === "description") ||
                (input.phase === "export" && message.kind === "delivery")
                ? message
                : failed,
            );
            return;
          }
          if (input.phase !== "export" || seen.has(message.id) || requests.size >= 4) {
            finish(failed);
            return;
          }
          seen.add(message.id);
          const request = canvasExportWorkerFetch(
            message,
            input.allowedOrigins,
            input.current,
            controller.signal,
          )
            .then(
              (response) => send(response),
              () => send({ kind: "fetch-response", id: message.id, failed: true }),
            )
            .finally(() => requests.delete(request));
          requests.add(request);
        }
      });
      stdout.once("end", () => finish(failed));
      stdout.once("error", () => finish(failed));
      stdin.once("error", () => finish(failed));
      started.process.wait.then(
        () => finish(failed),
        () => finish(failed),
      );
      send(request);
    });
  } catch {
    return failed;
  } finally {
    controller.abort();
    if (deadline !== undefined) clearTimeout(deadline);
    if (authorityPoll !== undefined) clearInterval(authorityPoll);
    await stop?.();
    await Promise.allSettled(requests);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

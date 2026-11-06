import { describe, expect, it, vi } from "vitest";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import type { CodeDirectoryPort } from "./codeDirectoryPort";
import { CodeFileWatchService } from "./codeFileWatchService";
import type { CodeFileWatchPort } from "./codeFileWatchPort";
import { liveCodeFileWatchPort } from "./codeFileWatchPort";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const threadId = "11111111-1111-4111-8111-111111111111" as CodeThreadId;
const checkoutId = "22222222-2222-4222-8222-222222222222" as CodeCheckoutId;
const rootPath = "/repo";

/** A directory port whose only interesting answer is that `/repo` is a directory. */
function directoryPort(isDirectory = true): CodeDirectoryPort {
  const stat = {
    isDirectory,
    isFile: !isDirectory,
    isSymbolicLink: false,
    size: 0,
    device: "1",
    inode: "1",
  };
  return {
    realpath: async (path) => path,
    lstat: async () => stat,
    stat: async () => stat,
    readlink: async () => {
      throw new Error("not a symlink");
    },
    openDirectory: async () => {
      throw new Error("unused");
    },
  };
}

interface Emitter extends CodeFileWatchPort {
  /** Resolves once the service has actually subscribed to the root. */
  readonly subscribed: Promise<void>;
  change(relativePath?: string): void;
  fail(): void;
  readonly closed: () => boolean;
}

function emitter(): Emitter {
  let onChange: ((path: string | undefined) => void) | undefined;
  let onFailure: (() => void) | undefined;
  let closed = false;
  let announce: () => void = () => undefined;
  const subscribed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return {
    subscribed,
    watch(_root, change, failure) {
      onChange = change;
      onFailure = failure;
      announce();
      return {
        close: () => {
          closed = true;
        },
      };
    },
    change: (relativePath) => onChange?.(relativePath),
    fail: () => onFailure?.(),
    closed: () => closed,
  };
}

function service(port: CodeFileWatchPort, directory = directoryPort()): CodeFileWatchService {
  return new CodeFileWatchService({
    watchPort: port,
    directoryPort: directory,
    clock: () => "2026-01-01T00:00:00.000Z",
    quietPeriodMs: 0,
  });
}

describe("CodeFileWatchService", () => {
  it("observes creation, rename, edit and deletion at the supported seventeen-root limit", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-visible-folders-")));
    const roots = Array.from({ length: 17 }, (_, index) => join(root, String(index)));
    roots.forEach((path) => mkdirSync(path));
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 15000);
    const watch = vi.fn(liveCodeFileWatchPort.watch);
    const shared = new CodeFileWatchService({ watchPort: { watch }, quietPeriodMs: 30 });
    const streams = roots.map((rootPath) =>
      shared.watch({ threadId, checkoutId, rootPath, signal: abort.signal }),
    );
    const next = () => streams.map((stream) => stream.next());
    const settle = async (pending: ReturnType<typeof next>) => {
      const frames = await Promise.all(pending);
      expect(frames.every((frame) => !frame.done && frame.value.paths.length > 0)).toBe(true);
    };
    try {
      let pending = next();
      await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(17));
      roots.forEach((path) => writeFileSync(join(path, "first.txt"), "created"));
      await settle(pending);
      pending = next();
      roots.forEach((path) => renameSync(join(path, "first.txt"), join(path, "second.txt")));
      await settle(pending);
      pending = next();
      roots.forEach((path) => writeFileSync(join(path, "second.txt"), "edited"));
      await settle(pending);
      pending = next();
      roots.forEach((path) => rmSync(join(path, "second.txt")));
      await settle(pending);
    } finally {
      clearTimeout(deadline);
      abort.abort();
      await Promise.allSettled(streams.map((stream) => stream.return(undefined)));
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("shares one host subscription across readers and keeps the remaining reader live", async () => {
    const port = emitter();
    const watch = vi.spyOn(port, "watch");
    const shared = service(port);
    const firstAbort = new AbortController(),
      secondAbort = new AbortController();
    const first = shared.watch({ threadId, checkoutId, rootPath, signal: firstAbort.signal });
    const second = shared.watch({ threadId, checkoutId, rootPath, signal: secondAbort.signal });
    const a = first.next(),
      b = second.next();
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    port.change("one.txt");
    expect((await a).value?.paths).toEqual(["one.txt"]);
    expect((await b).value?.paths).toEqual(["one.txt"]);
    firstAbort.abort();
    await first.return(undefined);
    expect(port.closed()).toBe(false);
    const next = second.next();
    port.change("two.txt");
    expect((await next).value?.paths).toEqual(["two.txt"]);
    secondAbort.abort();
    await second.return(undefined);
    expect(port.closed()).toBe(true);
  });
  it("coalesces a burst of changes into one notice of relative paths", async () => {
    const port = emitter();
    const stream = service(port).watch({ threadId, checkoutId, rootPath });
    const next = stream.next();
    await port.subscribed;
    port.change("src/app.ts");
    port.change("src/app.ts");
    port.change("README.md");

    const notice = (await next).value;
    expect(notice?.paths).toEqual(["README.md", "src/app.ts"]);
    expect(notice?.truncated).toBe(false);
    await stream.return(undefined);
  });

  it("ignores churn under directories the explorer never lists", async () => {
    const port = emitter();
    const stream = service(port).watch({ threadId, checkoutId, rootPath });
    const next = stream.next();
    await port.subscribed;
    port.change(".git/index");
    port.change("node_modules/left-pad/index.js");
    port.change("src/app.ts");

    expect((await next).value?.paths).toEqual(["src/app.ts"]);
    await stream.return(undefined);
  });

  it("marks the notice truncated when the host reports a change it cannot name", async () => {
    const port = emitter();
    const stream = service(port).watch({ threadId, checkoutId, rootPath });
    const next = stream.next();
    await port.subscribed;
    port.change(undefined);

    const notice = (await next).value;
    expect(notice?.paths).toEqual([]);
    expect(notice?.truncated).toBe(true);
    await stream.return(undefined);
  });

  it("refuses a name the confined relative-path contract rejects", async () => {
    const port = emitter();
    const stream = service(port).watch({ threadId, checkoutId, rootPath });
    const next = stream.next();
    await port.subscribed;
    port.change("../outside/secret.env");

    const notice = (await next).value;
    expect(notice?.paths).toEqual([]);
    expect(notice?.truncated).toBe(true);
    await stream.return(undefined);
  });

  it("reports truncated rather than naming more paths than one notice may carry", async () => {
    const port = emitter();
    const watcher = new CodeFileWatchService({
      watchPort: port,
      directoryPort: directoryPort(),
      clock: () => "2026-01-01T00:00:00.000Z",
      quietPeriodMs: 0,
      maxPaths: 2,
    });
    const stream = watcher.watch({ threadId, checkoutId, rootPath });
    const next = stream.next();
    await port.subscribed;
    port.change("a.ts");
    port.change("b.ts");
    port.change("c.ts");

    const notice = (await next).value;
    expect(notice?.paths).toEqual(["a.ts", "b.ts"]);
    expect(notice?.truncated).toBe(true);
    await stream.return(undefined);
  });

  it("says the whole surface is stale when the host drops the watcher", async () => {
    const port = emitter();
    const stream = service(port).watch({ threadId, checkoutId, rootPath });
    const next = stream.next();
    await port.subscribed;
    port.fail();

    // Reopening the watch cannot recover the changes made while nothing was
    // watching, and a stream that simply ends looks the same as a quiet one.
    // The last thing a dropped watch says is that everything must be re-read.
    const notice = (await next).value;
    expect(notice?.paths).toEqual([]);
    expect(notice?.truncated).toBe(true);
    expect((await stream.next()).done).toBe(true);
    expect(port.closed()).toBe(true);
  });

  it("ends the stream and closes the watcher when the caller aborts", async () => {
    const port = emitter();
    const controller = new AbortController();
    const stream = service(port).watch({
      threadId,
      checkoutId,
      rootPath,
      signal: controller.signal,
    });
    const next = stream.next();
    await port.subscribed;
    controller.abort();

    expect((await next).done).toBe(true);
    expect(port.closed()).toBe(true);
  });

  it("never subscribes when the checkout root is not a directory", async () => {
    const port = emitter();
    let subscribed = false;
    const observing: CodeFileWatchPort = {
      watch: (root, change, failure) => {
        subscribed = true;
        return port.watch(root, change, failure);
      },
    };
    const stream = service(observing, directoryPort(false)).watch({
      threadId,
      checkoutId,
      rootPath,
    });

    expect((await stream.next()).done).toBe(true);
    expect(subscribed).toBe(false);
  });

  it("never subscribes when the checkout root is not an absolute path", async () => {
    const port = emitter();
    let subscribed = false;
    const observing: CodeFileWatchPort = {
      watch: (root, change, failure) => {
        subscribed = true;
        return port.watch(root, change, failure);
      },
    };
    const stream = service(observing).watch({ threadId, checkoutId, rootPath: "repo" });

    expect((await stream.next()).done).toBe(true);
    expect(subscribed).toBe(false);
  });
});

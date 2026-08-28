import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCodeFileHelper,
  codeFileHelperBuildArgs,
  shouldBuildCodeFileHelper,
} from "./build-code-file-helper";

const repositoryRoot = resolve(import.meta.dirname, "..");
const correlationId = "70000000-0000-4000-8000-000000000003";
let fixtureRoot = "";
let helperPath = "";
const stderrByChild = new WeakMap<ChildProcessWithoutNullStreams, string>();

type JsonObject = Record<string, unknown>;

function frame(value: JsonObject): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function startHelper(): ChildProcessWithoutNullStreams {
  const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  stderrByChild.set(child, "");
  child.stderr.on("data", (chunk: Buffer) => {
    stderrByChild.set(child, `${stderrByChild.get(child) ?? ""}${chunk.toString()}`);
  });
  return child;
}

function responseReader(child: ChildProcessWithoutNullStreams) {
  let buffered = Buffer.alloc(0);
  const pending: Array<(value: JsonObject) => void> = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) return;
      const payload = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      pending.shift()?.(JSON.parse(payload.toString("utf8")) as JsonObject);
    }
  });
  return () => new Promise<JsonObject>((resolveResponse) => pending.push(resolveResponse));
}

async function rootIdentity(root: string) {
  const metadata = await stat(root, { bigint: true });
  return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

function request(
  rootPath: string,
  identity: JsonObject,
  operation: string,
  extra: JsonObject = {},
) {
  return {
    protocolVersion: 1,
    correlationId,
    operation,
    rootPath,
    rootIdentity: identity,
    pathComponents: ["fixture.txt"],
    ...extra,
  };
}

async function send(
  child: ChildProcessWithoutNullStreams,
  readResponse: () => Promise<JsonObject>,
  value: JsonObject,
) {
  child.stdin.write(frame(value));
  return readResponse();
}

beforeAll(async () => {
  if (!shouldBuildCodeFileHelper()) return;
  fixtureRoot = await mkdtemp(join(tmpdir(), "octant-code-helper-test-"));
  helperPath = join(fixtureRoot, "octant-code-file-helper");
  await buildCodeFileHelper(undefined, helperPath);
}, 30_000);

afterAll(async () => {
  if (fixtureRoot === "") return;
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("Code file helper build", () => {
  it("skips the Swift Code file helper off macOS so Linux builds do not require swiftc", () => {
    expect(shouldBuildCodeFileHelper("darwin")).toBe(true);
    expect(shouldBuildCodeFileHelper("linux")).toBe(false);
    expect(shouldBuildCodeFileHelper("win32")).toBe(false);
  });

  it("pins an optimized Apple Silicon macOS 14 executable", async () => {
    expect(codeFileHelperBuildArgs("/repo/helper.swift", "/repo/dist/helper")).toEqual([
      "swiftc",
      "-O",
      "-target",
      "arm64-apple-macos14.0",
      "-o",
      "/repo/dist/helper",
      "/repo/helper.swift",
    ]);
    if (!shouldBuildCodeFileHelper()) return;
    expect((await stat(helperPath)).mode & 0o111).toBe(0o111);
  });

  it("keeps the native source descriptor-relative, bounded, and path-silent", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "apps/desktop/native/code-file-helper/OctantCodeFileHelper.swift"),
      "utf8",
    );
    expect(source).toContain("private let maximumFrameBytes = 1_048_576");
    expect(source).toContain("private let maximumReadBytes = 20 * 1_024 * 1_024");
    expect(source).toContain("private let maximumWriteBytes = 5 * 1_024 * 1_024");
    expect(source).toContain("openat(");
    expect(source).toContain("fstatat(");
    expect(source).toContain("O_NOFOLLOW");
    expect(source).toContain("AT_SYMLINK_NOFOLLOW");
    expect(source).toContain("renameat(");
    expect(source).not.toContain("FileHandle.standardError.write");
    expect(source).not.toContain("localizedDescription");
  });
});

const describeNativeFixture = shouldBuildCodeFileHelper() ? describe : describe.skip;
describeNativeFixture("Code file helper native fixture", () => {
  it("inspects through a retained root descriptor and rejects final/intermediate symlinks and hardlinks", async () => {
    const root = join(fixtureRoot, "inspect-root");
    const movedRoot = join(fixtureRoot, "inspect-root-moved");
    await mkdir(root);
    await writeFile(join(root, "fixture.txt"), "original");
    await link(join(root, "fixture.txt"), join(root, "hardlink.txt"));
    await symlink("fixture.txt", join(root, "symlink.txt"));
    await mkdir(join(root, "directory"));
    await symlink("directory", join(root, "directory-link"));
    const identity = await rootIdentity(root);
    const child = startHelper();
    const next = responseReader(child);

    const hardlink = await send(child, next, request(root, identity, "inspect"));
    expect(hardlink).toMatchObject({ ok: false, failure: { code: "hardlink" } });

    await rm(join(root, "hardlink.txt"));
    const inspected = await send(child, next, request(root, identity, "inspect"));
    expect(inspected).toMatchObject({ protocolVersion: 1, correlationId, ok: true });
    expect(Object.keys(inspected).sort()).toEqual([
      "correlationId",
      "ok",
      "protocolVersion",
      "result",
    ]);
    expect(inspected).toHaveProperty(
      "result.metadata.digest",
      createHash("sha256").update("original").digest("hex"),
    );

    const symlinkResult = await send(
      child,
      next,
      request(root, identity, "inspect", { pathComponents: ["symlink.txt"] }),
    );
    expect(symlinkResult).toMatchObject({ ok: false, failure: { code: "symlink" } });

    const intermediate = await send(
      child,
      next,
      request(root, identity, "inspect", { pathComponents: ["directory-link", "missing"] }),
    );
    expect(intermediate).toMatchObject({ ok: false, failure: { code: "symlink" } });

    await rename(root, movedRoot);
    await mkdir(root);
    await writeFile(join(root, "fixture.txt"), "replacement");
    const retained = await send(child, next, request(root, identity, "inspect"));
    expect(retained).toHaveProperty(
      "result.metadata.digest",
      createHash("sha256").update("original").digest("hex"),
    );

    child.stdin.end();
    await once(child, "exit");
    expect(stderrByChild.get(child)).toBe("");
  });

  it("rejects stale root identity, traversal, partial frames, and oversized frames with typed failures", async () => {
    const root = join(fixtureRoot, "failure-root");
    await mkdir(root);
    await writeFile(join(root, "fixture.txt"), "fixture");
    const identity = await rootIdentity(root);

    for (const [bytes, code] of [
      [frame(request(root, { ...identity, inode: "1" }, "inspect")), "rootMismatch"],
      [
        frame(
          request(
            root,
            { ...identity, device: (BigInt(identity.device) + 1n).toString() },
            "inspect",
          ),
        ),
        "rootMismatch",
      ],
      [frame(request(root, identity, "inspect", { pathComponents: [".."] })), "escaped"],
      [Buffer.from([0, 0, 0, 24, 123]), "malformed"],
      [Buffer.from([0, 16, 0, 1]), "oversized"],
    ] as const) {
      const child = startHelper();
      const next = responseReader(child);
      child.stdin.end(bytes);
      expect(await next()).toMatchObject({ ok: false, failure: { code } });
      await once(child, "exit");
    }
  });

  it("streams bounded reads and exclusive writes across frame-sized chunks with digest commit", async () => {
    const root = join(fixtureRoot, "session-root");
    await mkdir(root);
    const content = Buffer.alloc(1_200_000, 0x61);
    await writeFile(join(root, "fixture.txt"), content);
    const identity = await rootIdentity(root);
    const child = startHelper();
    const next = responseReader(child);

    const started = await send(child, next, request(root, identity, "startRead"));
    expect(started).toMatchObject({ ok: true, result: { totalLength: 1_200_000 } });
    const readSessionId = (started.result as JsonObject).sessionId as string;
    const first = await send(
      child,
      next,
      request(root, identity, "readChunk", { sessionId: readSessionId, maximumBytes: 700_000 }),
    );
    const second = await send(
      child,
      next,
      request(root, identity, "readChunk", { sessionId: readSessionId, maximumBytes: 700_000 }),
    );
    expect(Buffer.from((first.result as JsonObject).dataBase64 as string, "base64").length).toBe(
      700_000,
    );
    expect(Buffer.from((second.result as JsonObject).dataBase64 as string, "base64").length).toBe(
      500_000,
    );
    expect(second).toMatchObject({ result: { eof: true } });

    const writeContent = Buffer.alloc(1_100_000, 0x62);
    const writeStarted = await send(
      child,
      next,
      request(root, identity, "beginWrite", {
        pathComponents: ["temporary.txt"],
        expectedIdentity: null,
        expectedDigest: null,
      }),
    );
    expect(writeStarted).toMatchObject({ ok: true });
    const writeSessionId = (writeStarted.result as JsonObject).uploadId as string;
    for (const chunk of [writeContent.subarray(0, 600_000), writeContent.subarray(600_000)]) {
      expect(
        await send(
          child,
          next,
          request(root, identity, "writeChunk", {
            uploadId: writeSessionId,
            chunkBase64: chunk.toString("base64"),
          }),
        ),
      ).toMatchObject({ ok: true });
    }
    expect(
      await send(
        child,
        next,
        request(root, identity, "commitWrite", {
          uploadId: writeSessionId,
          expectedLength: writeContent.length,
          expectedDigest: createHash("sha256").update(writeContent).digest("hex"),
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(await readFile(join(root, "temporary.txt"))).toEqual(writeContent);

    const cancellation = await send(
      child,
      next,
      request(root, identity, "beginWrite", {
        pathComponents: ["cancelled.txt"],
        expectedIdentity: null,
        expectedDigest: null,
      }),
    );
    const cancellationId = (cancellation.result as JsonObject).uploadId;
    expect(
      await send(
        child,
        next,
        request(root, identity, "cancelSession", { sessionId: cancellationId }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await send(
        child,
        next,
        request(root, identity, "writeChunk", {
          uploadId: cancellationId,
          chunkBase64: "YQ==",
        }),
      ),
    ).toMatchObject({ ok: false, failure: { code: "interrupted" } });

    child.stdin.end();
    await once(child, "exit");
  }, 30_000);

  it("detects stale commits, removes unfinished uploads, and performs guarded rename/delete", async () => {
    const root = join(fixtureRoot, "mutation-root");
    await mkdir(root);
    await writeFile(join(root, "fixture.txt"), "before");
    const identity = await rootIdentity(root);
    const child = startHelper();
    const next = responseReader(child);

    const inspected = await send(child, next, request(root, identity, "inspect"));
    const metadata = ((inspected.result as JsonObject).metadata ?? {}) as JsonObject;
    const begun = await send(
      child,
      next,
      request(root, identity, "beginWrite", {
        expectedIdentity: metadata.identity,
        expectedDigest: metadata.digest,
      }),
    );
    const uploadId = (begun.result as JsonObject).uploadId;
    expect(
      await send(
        child,
        next,
        request(root, identity, "writeChunk", {
          uploadId,
          chunkBase64: Buffer.from("after").toString("base64"),
        }),
      ),
    ).toMatchObject({ ok: true });
    await writeFile(join(root, "fixture.txt"), "external-change");
    expect(
      await send(
        child,
        next,
        request(root, identity, "commitWrite", {
          uploadId,
          expectedLength: 5,
          expectedDigest: createHash("sha256").update("after").digest("hex"),
        }),
      ),
    ).toMatchObject({ ok: false, failure: { code: "digestMismatch" } });
    expect((await readdir(root)).filter((name) => name.startsWith(".octant-"))).toEqual([]);

    const changed = await send(child, next, request(root, identity, "inspect"));
    const changedMetadata = ((changed.result as JsonObject).metadata ?? {}) as JsonObject;
    await writeFile(join(root, "renamed.txt"), "collision");
    expect(
      await send(
        child,
        next,
        request(root, identity, "rename", {
          destinationPathComponents: ["renamed.txt"],
          expectedIdentity: changedMetadata.identity,
          expectedDigest: changedMetadata.digest,
        }),
      ),
    ).toMatchObject({ ok: false, failure: { code: "alreadyExists" } });
    await rm(join(root, "renamed.txt"));
    expect(
      await send(
        child,
        next,
        request(root, identity, "rename", {
          destinationPathComponents: ["renamed.txt"],
          expectedIdentity: changedMetadata.identity,
          expectedDigest: changedMetadata.digest,
        }),
      ),
    ).toMatchObject({ ok: true, result: {} });
    await expect(readFile(join(root, "fixture.txt"))).rejects.toThrow();
    expect(await readFile(join(root, "renamed.txt"), "utf8")).toBe("external-change");

    const renamed = await send(
      child,
      next,
      request(root, identity, "inspect", { pathComponents: ["renamed.txt"] }),
    );
    const renamedMetadata = ((renamed.result as JsonObject).metadata ?? {}) as JsonObject;
    expect(
      await send(
        child,
        next,
        request(root, identity, "delete", {
          pathComponents: ["renamed.txt"],
          expectedIdentity: renamedMetadata.identity,
          expectedDigest: renamedMetadata.digest,
        }),
      ),
    ).toMatchObject({ ok: true, result: {} });
    await expect(readFile(join(root, "renamed.txt"))).rejects.toThrow();

    const unfinished = await send(
      child,
      next,
      request(root, identity, "beginWrite", {
        pathComponents: ["unfinished.txt"],
        expectedIdentity: null,
        expectedDigest: null,
      }),
    );
    expect((unfinished.result as JsonObject).uploadId).toEqual(expect.any(String));
    child.stdin.end();
    await once(child, "exit");
    expect((await readdir(root)).filter((name) => name.startsWith(".octant-"))).toEqual([]);
    expect(stderrByChild.get(child)).toBe("");
  });
});

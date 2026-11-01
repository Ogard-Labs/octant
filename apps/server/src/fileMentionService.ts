import {
  decodeFileMentionCommand,
  decodeFileMentionCommandResult,
  decodeFileMentionPath,
  decodeFileMentionRequestId,
  MAX_FILE_MENTION_CHARACTERS,
  type FileMentionCommand,
  type FileMentionCommandResult,
  type FileMentionRequestId,
  type FileMentionScope,
  type UnavailableFileMention,
  type WindowId,
} from "@octant/contracts";
import {
  boundFileMentionText,
  classifyFileMentionExtraFolderPath,
  classifyFileMentionRelativePath,
  FILE_MENTION_OUT_OF_ROOT_CONTEXT,
  FILE_MENTION_UNREADABLE_CONTEXT,
  fileMentionQueryEscapesRoot,
  formatFileMentionContext,
  rankFileMentionCandidates,
} from "@octant/domain";
import {
  createFileMentionIo,
  type FileMentionIo,
  type FileMentionRootIdentity,
} from "./fileMentionIo";

export type FileMentionRootResolution =
  | {
      readonly kind: "ok";
      readonly rootPath: string;
      readonly rootIdentity: FileMentionRootIdentity;
      /**
       * The Project's extra folders that exist, each pinned like the main
       * root. Their files are named by absolute path.
       */
      readonly extraRoots?: ReadonlyArray<{
        readonly rootPath: string;
        readonly rootIdentity: FileMentionRootIdentity;
      }>;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-found" };

const LISTING_CACHE_MS = 2_000;
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const prefixDecoder = new TextDecoder("utf-8", { fatal: false });

export interface FileMentionAuthority {
  resolveCodeRoot(
    windowId: WindowId,
    threadId: string,
    checkoutId: string,
  ): Promise<FileMentionRootResolution>;
  resolveWorkRoot(windowId: WindowId, threadId: string): Promise<FileMentionRootResolution>;
}

/**
 * Resolve one mentioned path against a bound root.
 *
 * Classification of the relative path runs first and does not use `io`. A
 * parent-traversal or absolute path is `out-of-root` before any filesystem
 * method is called. Only an in-root name is located, and only a located file
 * is read.
 */
export async function resolveMentionedFile(input: {
  readonly relativePath: string;
  readonly rootPath: string;
  readonly io: FileMentionIo;
  readonly rootIdentity?: FileMentionRootIdentity;
}): Promise<
  | {
      readonly kind: "resolved";
      readonly path: string;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly path: string;
      readonly reason: UnavailableFileMention["reason"];
    }
> {
  const classified = classifyFileMentionRelativePath(input.relativePath);
  if (classified.kind === "out-of-root") {
    return { kind: "unavailable", path: input.relativePath, reason: "out-of-root" };
  }
  const located =
    input.rootIdentity === undefined
      ? await input.io.locate(input.rootPath, classified.path)
      : await input.io.locate(input.rootPath, classified.path, input.rootIdentity);
  if (located.kind === "escapes-root") {
    return { kind: "unavailable", path: classified.path, reason: "out-of-root" };
  }
  if (located.kind !== "file") {
    return { kind: "unavailable", path: classified.path, reason: "not-found" };
  }
  const maximumBytes = MAX_FILE_MENTION_CHARACTERS * 4;
  const bytes = await input.io.readBytes(
    located.canonicalPath,
    { device: located.device, inode: located.inode },
    maximumBytes,
  );
  if (bytes === undefined) {
    return { kind: "unavailable", path: classified.path, reason: "not-found" };
  }
  let text: string;
  try {
    text =
      located.size > bytes.byteLength ? prefixDecoder.decode(bytes) : fatalDecoder.decode(bytes);
  } catch {
    return { kind: "unavailable", path: classified.path, reason: "not-found" };
  }
  const bounded = boundFileMentionText(text);
  return {
    kind: "resolved",
    path: classified.path,
    text: bounded.text,
    truncated: bounded.truncated || located.size > bytes.byteLength,
  };
}

/**
 * Turn selected `@file` paths into provider context blocks. Out-of-root paths
 * become an explicit unread notice; they never contribute file bytes.
 */
export async function fileMentionContextBlocks(
  service: FileMentionService,
  input: {
    readonly windowId: WindowId;
    readonly scope: FileMentionScope;
    readonly paths: ReadonlyArray<string>;
    readonly requestId?: FileMentionRequestId;
  },
): Promise<ReadonlyArray<{ readonly kind: "user-message"; readonly text: string }>> {
  if (input.paths.length === 0) return [];
  const result = await service.execute(
    {
      kind: "resolve-file-mentions",
      requestId: input.requestId ?? decodeFileMentionRequestId(randomFileMentionRequestId()),
      scope: input.scope,
      paths: [...input.paths],
    },
    { windowId: input.windowId },
  );
  if (result.kind !== "file-mentions-resolved") {
    return input.paths.map(() => ({
      kind: "user-message" as const,
      text: FILE_MENTION_UNREADABLE_CONTEXT,
    }));
  }
  const resolved = formatFileMentionContext(result.mentions);
  const notices = result.unavailable.map((entry) =>
    entry.reason === "out-of-root"
      ? FILE_MENTION_OUT_OF_ROOT_CONTEXT
      : FILE_MENTION_UNREADABLE_CONTEXT,
  );
  return [
    ...(resolved.length === 0 ? [] : [{ kind: "user-message" as const, text: resolved }]),
    ...notices.map((text) => ({ kind: "user-message" as const, text })),
  ];
}

function randomFileMentionRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export class FileMentionService {
  readonly #authority: FileMentionAuthority;
  readonly #io: FileMentionIo;
  readonly #listings = new Map<
    string,
    { readonly expiresAt: number; readonly promise: ReturnType<FileMentionIo["list"]> }
  >();

  constructor(options: { readonly authority: FileMentionAuthority; readonly io?: FileMentionIo }) {
    this.#authority = options.authority;
    this.#io = options.io ?? createFileMentionIo();
  }

  async execute(
    commandInput: unknown,
    context: { readonly windowId: WindowId },
  ): Promise<FileMentionCommandResult> {
    let command: FileMentionCommand;
    try {
      command = decodeFileMentionCommand(commandInput);
    } catch {
      return failed(unknownRequestId(commandInput), "invalid");
    }
    const root = await this.#resolveRoot(context.windowId, command.scope);
    if (root.kind !== "ok") return failed(command.requestId, root.kind);

    if (command.kind === "complete-file-mentions") {
      return this.#complete(command.requestId, root, command.query);
    }
    return this.#resolve(command.requestId, root, command.paths);
  }

  async #complete(
    requestId: FileMentionRequestId,
    root: Extract<FileMentionRootResolution, { readonly kind: "ok" }>,
    query: string,
  ): Promise<FileMentionCommandResult> {
    // An extra folder's files are named by absolute path, so a query may
    // start with one slash; the rest of it is checked as any query is.
    if (fileMentionQueryEscapesRoot(query.startsWith("/") ? query.slice(1) : query)) {
      return decodeFileMentionCommandResult({
        kind: "file-mentions-completed",
        requestId,
        candidates: [],
      });
    }
    const listed = [...(await this.#listCached(root))];
    for (const extra of root.extraRoots ?? []) {
      const files = await this.#listCached(extra);
      for (const file of files) {
        // A folder whose own path the wire cannot carry (a backslash,
        // decomposed Unicode, too long) loses its files, not everyone's.
        try {
          listed.push({ ...file, path: decodeFileMentionPath(`${extra.rootPath}/${file.path}`) });
        } catch {
          break;
        }
      }
    }
    return decodeFileMentionCommandResult({
      kind: "file-mentions-completed",
      requestId,
      candidates: rankFileMentionCandidates(listed, query),
    });
  }

  async #listCached(root: {
    readonly rootPath: string;
    readonly rootIdentity: FileMentionRootIdentity;
  }): ReturnType<FileMentionIo["list"]> {
    const key = `${root.rootPath}\0${root.rootIdentity.device}\0${root.rootIdentity.inode}`;
    const now = Date.now();
    const cached = this.#listings.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.promise;
    const promise = this.#io.list(root.rootPath, root.rootIdentity);
    this.#listings.set(key, { expiresAt: now + LISTING_CACHE_MS, promise });
    try {
      return await promise;
    } catch (error) {
      this.#listings.delete(key);
      throw error;
    }
  }

  async #resolve(
    requestId: FileMentionRequestId,
    root: Extract<FileMentionRootResolution, { readonly kind: "ok" }>,
    paths: ReadonlyArray<string>,
  ): Promise<FileMentionCommandResult> {
    const mentions: Array<{
      path: ReturnType<typeof decodeFileMentionPath>;
      text: string;
      truncated: boolean;
    }> = [];
    const unavailable: UnavailableFileMention[] = [];
    const extraRoots = root.extraRoots ?? [];
    for (const mentioned of paths) {
      // An absolute path is read only from the extra folder it lies inside;
      // anything else absolute stays out of root.
      const inFolder = mentioned.startsWith("/")
        ? classifyFileMentionExtraFolderPath(
            mentioned,
            extraRoots.map((extra) => extra.rootPath),
          )
        : undefined;
      const extra =
        inFolder?.kind === "in-folder"
          ? extraRoots.find((candidate) => candidate.rootPath === inFolder.folder)
          : undefined;
      const resolved = await resolveMentionedFile({
        relativePath: inFolder?.kind === "in-folder" ? inFolder.path : mentioned,
        rootPath: (extra ?? root).rootPath,
        io: this.#io,
        rootIdentity: (extra ?? root).rootIdentity,
      });
      if (resolved.kind === "unavailable") {
        unavailable.push({
          path: extra === undefined ? resolved.path : mentioned,
          reason: resolved.reason,
        });
        continue;
      }
      let path;
      try {
        path = decodeFileMentionPath(
          extra === undefined ? resolved.path : `${extra.rootPath}/${resolved.path}`,
        );
      } catch {
        unavailable.push({ path: resolved.path, reason: "out-of-root" });
        continue;
      }
      mentions.push({ path, text: resolved.text, truncated: resolved.truncated });
    }
    return decodeFileMentionCommandResult({
      kind: "file-mentions-resolved",
      requestId,
      mentions,
      unavailable,
    });
  }

  async #resolveRoot(
    windowId: WindowId,
    scope: FileMentionScope,
  ): Promise<FileMentionRootResolution> {
    if (scope.mode === "code") {
      return this.#authority.resolveCodeRoot(
        windowId,
        String(scope.threadId),
        String(scope.checkoutId),
      );
    }
    return this.#authority.resolveWorkRoot(windowId, String(scope.threadId));
  }
}

function failed(
  requestId: FileMentionRequestId,
  reason: "unauthorized" | "not-found" | "unsupported-mode" | "unavailable" | "invalid",
): FileMentionCommandResult {
  return decodeFileMentionCommandResult({ kind: "failed", requestId, reason });
}

function unknownRequestId(commandInput: unknown): FileMentionRequestId {
  if (typeof commandInput === "object" && commandInput !== null && "requestId" in commandInput) {
    try {
      return decodeFileMentionRequestId(commandInput.requestId);
    } catch {
      // Fall through to the nil id; this result is only shown when the
      // command itself could not be decoded.
    }
  }
  return decodeFileMentionRequestId("00000000-0000-4000-8000-000000000000");
}

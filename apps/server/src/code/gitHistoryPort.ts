import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { gitHistoryMetadata } from "./gitHistoryCheckout";
import {
  decodeGitHistoryQuery,
  decodeGitHistoryResult,
  MAX_GIT_HISTORY_DIFF_BYTES,
  MAX_GIT_HISTORY_PAGE,
  type GitHistoryCommit,
  type GitHistoryQuery,
  type GitHistoryRef,
  type GitHistoryResult,
} from "@octant/contracts/git-history";
import { createGitCommandEnvironment } from "../gitEnvironmentPort";
import {
  createGitSeatbeltConfinement,
  gitGlobalConfigReadRoots,
  type GitSeatbeltPortOptions,
} from "../process/gitSeatbeltLaunch";

const unavailable: GitHistoryResult = {
  status: "unavailable",
  message: "Git history is unavailable. Refresh or check this checkout's access.",
};
const LOG_FORMAT = "%H%x00%P%x00%an%x00%aI%x00%s";
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Local reads only. The host resolves the authorized root before calling this port. */
export class GitHistoryPort {
  readonly #sandbox: ReturnType<typeof createGitSeatbeltConfinement>;
  constructor(options: GitSeatbeltPortOptions = {}) {
    this.#sandbox = createGitSeatbeltConfinement({ ...options, networkEgress: "none" });
  }

  async read(
    root: string,
    input: GitHistoryQuery,
    signal?: AbortSignal,
  ): Promise<GitHistoryResult> {
    try {
      const query = decodeGitHistoryQuery(input);
      const canonicalRoot = await realpath(root);
      if (
        !isAbsolute(canonicalRoot) ||
        signal?.aborted ||
        (await gitHistoryMetadata(canonicalRoot)) === undefined
      )
        return unavailable;
      if (query.kind === "commit")
        return decodeGitHistoryResult(await this.#commit(canonicalRoot, query, signal));
      return decodeGitHistoryResult(await this.#history(canonicalRoot, query, signal));
    } catch {
      return unavailable;
    }
  }

  async #history(
    root: string,
    query: Extract<GitHistoryQuery, { kind: "history" }>,
    signal?: AbortSignal,
  ): Promise<GitHistoryResult> {
    const run = (args: ReadonlyArray<string>) => this.#run(root, args, signal);
    const [headResult, branchResult, shallowResult, refsResult] = await Promise.all([
      run(["rev-parse", "--verify", "HEAD"]),
      run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      run(["rev-parse", "--is-shallow-repository"]),
      run([
        "for-each-ref",
        "--count=257",
        "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)",
        "refs/heads/",
        "refs/remotes/",
        "refs/tags/",
      ]),
    ]);
    if (!shallowResult.ok || !refsResult.ok) return unavailable;
    const head = headResult.ok && OID.test(headResult.text.trim()) ? headResult.text.trim() : null;
    const refs: GitHistoryRef[] = [];
    for (const line of refsResult.text.trim().split("\n")) {
      if (line === "") continue;
      const [name, object, peeled, kind, peeledKind] = line.split("\0");
      if ((peeled ? peeledKind : kind) !== "commit") continue;
      const oid = peeled || object;
      if (name === undefined || oid === undefined || !OID.test(oid)) continue;
      refs.push({
        name,
        oid,
        kind: name.startsWith("refs/heads/")
          ? "branch"
          : name.startsWith("refs/remotes/")
            ? "remote"
            : "tag",
      });
    }
    const base = {
      status: "history" as const,
      threadId: query.threadId,
      checkoutId: query.checkoutId,
      head,
      branch: branchResult.ok ? branchResult.text.trim() : null,
      shallow: shallowResult.text.trim() === "true",
      refsTruncated: refs.length > 127,
      refs: refs.slice(0, 256),
    };
    let tips: ReadonlyArray<string>;
    if (query.cursor !== undefined) tips = query.cursor.tips;
    else if (query.revision !== undefined) {
      const resolved = await run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${query.revision}^{commit}`,
      ]);
      if (!resolved.ok || !OID.test(resolved.text.trim()))
        return head === null && query.revision === "HEAD"
          ? { ...base, commits: [], nextCursor: null }
          : unavailable;
      tips = [resolved.text.trim()];
    } else
      tips = [
        ...new Set([...(head === null ? [] : [head]), ...refs.slice(0, 127).map((ref) => ref.oid)]),
      ];
    if (tips.length === 0) return { ...base, commits: [], nextCursor: null };
    const offset = query.cursor?.offset ?? 0;
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    const scan = search === "" ? MAX_GIT_HISTORY_PAGE : 1000;
    const log = await run([
      "log",
      "--topo-order",
      "--no-decorate",
      "-z",
      `--format=${LOG_FORMAT}`,
      `--max-count=${scan + 1}`,
      `--skip=${offset}`,
      ...tips,
      "--",
    ]);
    if (!log.ok) return unavailable;
    const records = parseCommits(log.text);
    const commits: GitHistoryCommit[] = [];
    let consumed = 0;
    for (const entry of records.slice(0, scan)) {
      consumed++;
      if (
        search === "" ||
        `${entry.oid}\n${entry.author}\n${entry.subject}`.toLocaleLowerCase().includes(search)
      )
        commits.push(entry);
      if (commits.length === MAX_GIT_HISTORY_PAGE) break;
    }
    return {
      ...base,
      refsTruncated: base.refsTruncated || offset + consumed > 1_000_000,
      commits,
      nextCursor:
        records.length > consumed && offset + consumed <= 1_000_000
          ? { tips, offset: offset + consumed }
          : null,
    };
  }

  async #commit(
    root: string,
    query: Extract<GitHistoryQuery, { kind: "commit" }>,
    signal?: AbortSignal,
  ): Promise<GitHistoryResult> {
    const run = (args: ReadonlyArray<string>) => this.#run(root, args, signal);
    const [metadata, body] = await Promise.all([
      run(["log", "-1", "-z", `--format=${LOG_FORMAT}`, query.oid, "--"]),
      this.#run(root, ["show", "-s", "--format=%B", query.oid, "--"], signal, true),
    ]);
    if (!metadata.ok || !body.ok) return unavailable;
    const commit = parseCommits(metadata.text)[0];
    if (commit === undefined || commit.oid !== query.oid) return unavailable;
    const parent = commit.parents[query.parent] ?? null;
    if (parent === null && (commit.parents.length > 0 || query.parent !== 0)) return unavailable;
    const base =
      parent === null
        ? ["diff-tree", "--root", "--no-commit-id", "-r", query.oid]
        : ["diff", parent, query.oid];
    const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];
    const [patch, stats] = await Promise.all([
      this.#run(root, [...base, ...flags, "-p", "--"], signal, true),
      run([...base, ...flags, "--numstat", "-z", "--"]),
    ]);
    if (!patch.ok || !stats.ok) return unavailable;
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    const entries = stats.text.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined || entry === "") continue;
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entry);
      if (match === null) return unavailable;
      files++;
      insertions += match[1] === "-" ? 0 : Number(match[1]);
      deletions += match[2] === "-" ? 0 : Number(match[2]);
      if (match[3] === "") i += 2;
    }
    const bytes = Buffer.from(patch.text, "utf8");
    // Streaming decode drops a partial trailing codepoint instead of exceeding the byte budget with a replacement character.
    const diff = new TextDecoder().decode(bytes.subarray(0, MAX_GIT_HISTORY_DIFF_BYTES), {
      stream: bytes.length > MAX_GIT_HISTORY_DIFF_BYTES,
    });
    return {
      status: "commit",
      threadId: query.threadId,
      checkoutId: query.checkoutId,
      commit,
      parent,
      message: body.text.trimEnd().slice(0, 65536),
      diff,
      truncated: bytes.length > MAX_GIT_HISTORY_DIFF_BYTES || body.text.length > 65536,
      files,
      insertions,
      deletions,
    };
  }

  async #run(
    root: string,
    args: ReadonlyArray<string>,
    signal?: AbortSignal,
    acceptTruncated = false,
  ): Promise<{ readonly ok: boolean; readonly text: string }> {
    const metadata = await gitHistoryMetadata(root);
    if (metadata === undefined) return { ok: false, text: "" };
    const binaryDirectory = dirname(this.#sandbox.gitExecutable);
    const launch = this.#sandbox.confinement.prepare({
      executable: this.#sandbox.gitExecutable,
      args: ["-C", root, "-c", "core.quotePath=false", ...args],
      boundRoot: root,
      writeBoundRoot: false,
      additionalDenyWritePaths: [root, ...metadata],
      temporaryDirectory: this.#sandbox.temporaryDirectory,
      networkEgress: "none",
      allowFileReadStar: true,
      readRoots: [
        root,
        ...metadata,
        binaryDirectory,
        dirname(binaryDirectory),
        ...gitGlobalConfigReadRoots(),
      ],
    });
    return new Promise((resolve) => {
      execFile(
        launch.command,
        [...launch.args],
        {
          encoding: "utf8",
          shell: false,
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...createGitCommandEnvironment(process.env),
            GIT_NO_LAZY_FETCH: "1",
            GIT_OPTIONAL_LOCKS: "0",
          },
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout) =>
          resolve({
            ok:
              error === null ||
              (acceptTruncated && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"),
            text: stdout,
          }),
      );
    });
  }
}

function parseCommits(text: string): GitHistoryCommit[] {
  if (text === "") return [];
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 5 !== 0) throw new Error("Invalid Git history record");
  const result: GitHistoryCommit[] = [];
  for (let i = 0; i < fields.length; i += 5) {
    const [oid, parents, author, authoredAt, subject] = fields.slice(i, i + 5);
    if (
      oid === undefined ||
      parents === undefined ||
      author === undefined ||
      authoredAt === undefined ||
      subject === undefined
    )
      throw new Error("Incomplete Git history record");
    result.push({
      oid,
      parents: parents === "" ? [] : parents.split(" "),
      author: author.slice(0, 512),
      authoredAt,
      subject: subject.slice(0, 4096),
    });
  }
  return result;
}

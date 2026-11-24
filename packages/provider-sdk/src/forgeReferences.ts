import {
  MAX_THREAD_FORGE_REFERENCES_PER_CALL,
  type ThreadForgeAction,
  type ThreadForgeReference,
  type ThreadGithubForgeReference,
} from "@octant/contracts";

/**
 * One finished tool call as an adapter sees it, before anything is reduced or
 * redacted for the normalized event. Nothing here crosses: only the
 * references this module derives from it do.
 */
export interface ForgeToolCall {
  /** The tool's name as the runtime reports it, such as `Bash` or `mcp__github__merge_pull_request`. */
  readonly toolName: string;
  /** The full command a shell tool ran. */
  readonly command?: string;
  /** A structured tool's arguments. */
  readonly input?: unknown;
  /** The call's result text. */
  readonly output?: string;
}

type Kind = ThreadGithubForgeReference["kind"];

const GH_PR_WRITES: Readonly<Record<string, ThreadForgeAction>> = {
  create: "created",
  merge: "merged",
  review: "reviewed",
  comment: "commented",
  edit: "edited",
  ready: "edited",
  close: "closed",
  reopen: "reopened",
};

const GH_ISSUE_WRITES: Readonly<Record<string, ThreadForgeAction>> = {
  create: "created",
  comment: "commented",
  edit: "edited",
  close: "closed",
  reopen: "reopened",
};

const OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}`;
const REPOSITORY = String.raw`[A-Za-z0-9_.-]{1,100}`;
const GITHUB_URL = new RegExp(
  String.raw`https://github\.com/(${OWNER})/(${REPOSITORY})/(pull|issues)/([1-9][0-9]{0,8})(?![0-9])`,
  "g",
);
/** gh's own success lines: "Merged pull request owner/repo#12", "Closed issue owner/repo#7". */
const GH_SUCCESS_LINE = new RegExp(
  String.raw`\b(pull request|issue) (${OWNER})/(${REPOSITORY})#([1-9][0-9]{0,8})\b`,
  "g",
);
const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;
const LINEAR_URL = /https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8})\b/g;

interface GithubIdentity {
  readonly kind: Kind;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

function identityKey(identity: {
  readonly kind: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly identifier?: string;
}): string {
  return (
    identity.identifier ??
    `${identity.kind}:${identity.owner ?? ""}/${identity.repository ?? ""}#${String(identity.number ?? 0)}`.toLowerCase()
  );
}

function githubUrlsIn(text: string): ReadonlyArray<GithubIdentity> {
  const found: GithubIdentity[] = [];
  for (const match of text.matchAll(GITHUB_URL)) {
    const [, owner, repository, segment, number] = match;
    if (owner === undefined || repository === undefined || number === undefined) continue;
    found.push({
      kind: segment === "pull" ? "pull-request" : "issue",
      owner,
      repository,
      number: Number(number),
    });
  }
  return found;
}

function githubSuccessLinesIn(text: string): ReadonlyArray<GithubIdentity> {
  const found: GithubIdentity[] = [];
  for (const match of text.matchAll(GH_SUCCESS_LINE)) {
    const [, noun, owner, repository, number] = match;
    if (owner === undefined || repository === undefined || number === undefined) continue;
    found.push({
      kind: noun === "pull request" ? "pull-request" : "issue",
      owner,
      repository,
      number: Number(number),
    });
  }
  return found;
}

/**
 * Splits a command line into words, honouring single and double quotes, and
 * into separate commands at `&&`, `||`, `;`, `|` and line breaks. It is not a
 * shell: it only has to find `gh` invocations and their arguments.
 */
function shellCommands(command: string): ReadonlyArray<ReadonlyArray<string>> {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: '"' | "'" | undefined;
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === "\n" || character === ";" || character === "|" || character === "&") {
      endCommand();
      continue;
    }
    if (character === " " || character === "\t") {
      endWord();
      continue;
    }
    word += character;
    inWord = true;
  }
  endCommand();
  return commands;
}

interface GhInvocation {
  readonly kind: Kind;
  /** Undefined for a read (`view`, `list`, `checks`, `diff`, …). */
  readonly action: ThreadForgeAction | undefined;
  /** The identity the command names itself, when it names one fully. */
  readonly named: GithubIdentity | undefined;
  /** The number the command names without a repository. */
  readonly number: number | undefined;
}

function ghInvocation(words: ReadonlyArray<string>): GhInvocation | undefined {
  const at = words.findIndex((candidate) => candidate === "gh" || candidate.endsWith("/gh"));
  if (at === -1) return undefined;
  const noun = words[at + 1];
  const verb = words[at + 2];
  if ((noun !== "pr" && noun !== "issue") || verb === undefined) return undefined;
  const kind: Kind = noun === "pr" ? "pull-request" : "issue";
  const action = (noun === "pr" ? GH_PR_WRITES : GH_ISSUE_WRITES)[verb];
  const rest = words.slice(at + 3);
  let repository: { readonly owner: string; readonly repository: string } | undefined;
  let number: number | undefined;
  let named: GithubIdentity | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";
    const repoValue =
      argument === "--repo" || argument === "-R"
        ? rest[index + 1]
        : argument.startsWith("--repo=")
          ? argument.slice("--repo=".length)
          : undefined;
    if (repoValue !== undefined) {
      // `[HOST/]OWNER/REPO`; only github.com identities are exact here.
      const parts = repoValue.split("/");
      const owner = parts.at(-2);
      const name = parts.at(-1);
      if (
        owner !== undefined &&
        name !== undefined &&
        (parts.length === 2 || (parts.length === 3 && parts[0] === "github.com")) &&
        new RegExp(`^${OWNER}$`).test(owner) &&
        new RegExp(`^${REPOSITORY}$`).test(name)
      ) {
        repository = { owner, repository: name };
      }
      continue;
    }
    if (named === undefined) {
      const url = githubUrlsIn(argument)[0];
      if (url !== undefined && url.kind === kind) named = url;
    }
    if (number === undefined && /^#?[1-9][0-9]{0,8}$/.test(argument)) {
      number = Number(argument.replace("#", ""));
    }
  }
  if (named === undefined && repository !== undefined && number !== undefined) {
    named = { kind, ...repository, number };
  }
  return { kind, action, named, number };
}

function fromShell(
  command: string,
  output: string | undefined,
): ReadonlyArray<ThreadForgeReference> {
  const invocations = shellCommands(command)
    .map(ghInvocation)
    .filter((invocation): invocation is GhInvocation => invocation !== undefined);
  const found = [...githubUrlsIn(output ?? ""), ...githubSuccessLinesIn(output ?? "")];
  const references: ThreadForgeReference[] = [];
  for (const invocation of invocations) {
    if (invocation.action === undefined) continue;
    const action = invocation.action;
    const sameKind = invocations.filter((candidate) => candidate.kind === invocation.kind);
    let identity = invocation.named;
    if (identity === undefined && invocation.number !== undefined) {
      // A number without a repository: the output names the repository, and
      // only an exact match on kind and number completes it.
      const matches = found.filter(
        (candidate) => candidate.kind === invocation.kind && candidate.number === invocation.number,
      );
      const repositories = new Set(matches.map((candidate) => identityKey(candidate)));
      if (repositories.size === 1) identity = matches[0];
    }
    if (identity === undefined && invocation.number === undefined && sameKind.length === 1) {
      // A command that names no pull request or issue (`gh pr create`, or a
      // merge of the current branch's): the output's one identity of that
      // kind is the one it wrote. Several, or a read of the same kind in the
      // same command, leave it unknown rather than guessed.
      const ofKind = new Map(
        found
          .filter((candidate) => candidate.kind === invocation.kind)
          .map((candidate) => [identityKey(candidate), candidate] as const),
      );
      if (ofKind.size === 1) identity = [...ofKind.values()][0];
    }
    if (identity === undefined) continue;
    references.push({
      forge: "github",
      kind: identity.kind,
      action,
      owner: identity.owner,
      repository: identity.repository,
      number: identity.number,
    });
  }
  return references;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Every object in a parsed JSON value, depth first, bounded. */
function objectsIn(value: unknown, limit = 200): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const found: Array<Readonly<Record<string, unknown>>> = [];
  const visit = (current: unknown, depth: number) => {
    if (found.length >= limit || depth > 6) return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const object = record(current);
    if (object === undefined) return;
    found.push(object);
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return [...trimmed].slice(0, maximum).join("");
}

/** The part of a structured tool's name after its server prefix, lower-cased. */
function operationName(toolName: string): string {
  const lower = toolName.toLowerCase();
  const separator = lower.lastIndexOf("__");
  return separator === -1 ? lower : lower.slice(separator + 2);
}

const READ_WORDS = /(^|_)(get|list|search|read|fetch|view|find)(_|$)/;

function githubToolAction(
  operation: string,
  input: Readonly<Record<string, unknown>> | undefined,
): ThreadForgeAction | undefined {
  if (READ_WORDS.test(operation)) return undefined;
  if (!/pull_request|issue|review|comment/.test(operation)) return undefined;
  if (operation.includes("merge")) return "merged";
  if (operation.includes("review")) return "reviewed";
  if (operation.includes("comment")) return "commented";
  const method = typeof input?.method === "string" ? input.method.toLowerCase() : undefined;
  if (input?.state === "closed") return "closed";
  if (input?.state === "open" && method === "update") return "reopened";
  if (operation.startsWith("create") || method === "create") return "created";
  if (/update|edit|write/.test(operation)) return "edited";
  return undefined;
}

function numberField(
  input: Readonly<Record<string, unknown>> | undefined,
  names: ReadonlyArray<string>,
): number | undefined {
  for (const name of names) {
    const value = input?.[name];
    const number =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isInteger(number) && number > 0 && number < 1_000_000_000) return number;
  }
  return undefined;
}

/** A pull request or issue a structured tool's result named, with what it said of it. */
interface ResultIdentity {
  readonly identity: GithubIdentity;
  readonly title?: string;
  readonly state?: string;
}

function fromGithubTool(call: ForgeToolCall): ReadonlyArray<ThreadForgeReference> {
  const input = record(call.input);
  const operation = operationName(call.toolName);
  const action = githubToolAction(operation, input);
  if (action === undefined) return [];
  const parsed = parseJson(call.output);
  const objects = objectsIn(parsed);
  // The result's own address is the most exact identity; a create has no
  // number until the result names it.
  const fromResult = objects
    .map((object): ResultIdentity | undefined => {
      const url = text(object.html_url, 2_048) ?? text(object.url, 2_048);
      const identity = url === undefined ? undefined : githubUrlsIn(url)[0];
      if (identity === undefined) return undefined;
      const merged = object.merged === true || text(object.merged_at, 64) !== undefined;
      const state = merged ? "merged" : text(object.state, 64);
      const title = text(object.title, 256);
      return {
        identity,
        ...(title === undefined ? {} : { title }),
        ...(state === undefined ? {} : { state }),
      };
    })
    .filter((entry) => entry !== undefined);
  const first: ResultIdentity | undefined =
    fromResult[0] ??
    (() => {
      const urls = githubUrlsIn(call.output ?? "");
      return urls.length === 1 && urls[0] !== undefined ? { identity: urls[0] } : undefined;
    })();
  const owner = text(input?.owner, 39);
  const repository = text(input?.repo ?? input?.repository, 100);
  const number = numberField(input, [
    "pullNumber",
    "pull_number",
    "issue_number",
    "issueNumber",
    "number",
  ]);
  const kind: Kind =
    first?.identity.kind ?? (/pull_request|review/.test(operation) ? "pull-request" : "issue");
  const identity =
    first?.identity ??
    (owner !== undefined && repository !== undefined && number !== undefined
      ? { kind, owner, repository, number }
      : undefined);
  if (identity === undefined) return [];
  if (
    !new RegExp(`^${OWNER}$`).test(identity.owner) ||
    !new RegExp(`^${REPOSITORY}$`).test(identity.repository)
  ) {
    return [];
  }
  return [
    {
      forge: "github",
      kind: identity.kind,
      action,
      owner: identity.owner,
      repository: identity.repository,
      number: identity.number,
      ...(first?.title === undefined ? {} : { title: first.title }),
      ...(first?.state === undefined ? {} : { state: first.state }),
    },
  ];
}

function linearToolAction(
  operation: string,
  input: Readonly<Record<string, unknown>> | undefined,
): ThreadForgeAction | undefined {
  if (READ_WORDS.test(operation)) return undefined;
  if (operation.includes("comment")) return "commented";
  if (!operation.includes("issue")) return undefined;
  if (operation.startsWith("create")) return "created";
  if (operation.startsWith("save")) return input?.id === undefined ? "created" : "edited";
  if (/update|edit/.test(operation)) return "edited";
  return undefined;
}

function linearState(object: Readonly<Record<string, unknown>>): string | undefined {
  const direct = text(object.status, 64) ?? text(object.state, 64);
  if (direct !== undefined) return direct;
  const nested = record(object.status) ?? record(object.state);
  return text(nested?.name, 64);
}

/** The result's address for this issue, only when it is the issue's own linear.app page. */
function linearIssueUrl(url: string | undefined, identifier: string): string | undefined {
  if (url === undefined) return undefined;
  const match =
    /^https:\/\/linear\.app\/[A-Za-z0-9_.-]+\/issue\/([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8})(?:\/[A-Za-z0-9_.-]*)?$/.exec(
      url,
    );
  return match?.[1] === identifier ? url : undefined;
}

function fromLinearTool(call: ForgeToolCall): ReadonlyArray<ThreadForgeReference> {
  const input = record(call.input);
  const action = linearToolAction(operationName(call.toolName), input);
  if (action === undefined) return [];
  const objects = objectsIn(parseJson(call.output));
  for (const object of objects) {
    const identifier = text(object.identifier, 32);
    if (identifier === undefined || !LINEAR_IDENTIFIER.test(identifier)) continue;
    const title = text(object.title, 256);
    const state = linearState(object);
    const url = linearIssueUrl(text(object.url, 512), identifier);
    return [
      {
        forge: "linear",
        kind: "issue",
        action,
        identifier,
        ...(url === undefined ? {} : { url }),
        ...(title === undefined ? {} : { title }),
        ...(state === undefined ? {} : { state }),
      },
    ];
  }
  const fromUrl = [...(call.output ?? "").matchAll(LINEAR_URL)].map((match) => match[1]);
  const fromInput = [input?.issueId, input?.issue, input?.id]
    .map((value) => text(value, 32))
    .filter((value) => value !== undefined && LINEAR_IDENTIFIER.test(value));
  const identifiers = new Set([...fromUrl, ...fromInput].filter((value) => value !== undefined));
  if (identifiers.size !== 1) return [];
  const identifier = [...identifiers][0];
  return identifier === undefined ? [] : [{ forge: "linear", kind: "issue", action, identifier }];
}

/**
 * The pull requests and issues one finished tool call wrote to, by exact
 * identity, for an adapter to put on its `tool-success` event. A read never
 * counts, a title or branch name never stands in for an identity, and an
 * identity the call does not pin down exactly is left out rather than
 * guessed. Returns undefined when the call touched none.
 */
export function forgeReferencesFromToolCall(
  call: ForgeToolCall,
): ReadonlyArray<ThreadForgeReference> | undefined {
  const lower = call.toolName.toLowerCase();
  const found =
    call.command !== undefined
      ? fromShell(call.command, call.output)
      : lower.includes("github")
        ? fromGithubTool(call)
        : lower.includes("linear")
          ? fromLinearTool(call)
          : [];
  const unique = new Map<string, ThreadForgeReference>();
  for (const reference of found) {
    const key = identityKey(reference);
    if (!unique.has(key)) unique.set(key, reference);
  }
  const references = [...unique.values()].slice(0, MAX_THREAD_FORGE_REFERENCES_PER_CALL);
  return references.length === 0 ? undefined : references;
}

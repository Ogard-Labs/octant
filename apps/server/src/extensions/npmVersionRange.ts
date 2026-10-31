/**
 * Chooses one published npm version from what a person typed: an exact
 * version, a range (`^1.2.0`, `~1.2`, `>=1 <2`, `1.x`, `1.2.3 - 2.0.0`,
 * alternatives joined by `||`), a dist-tag, or nothing, which means `latest`.
 *
 * It reads no registry and no file, so the same words always choose the same
 * version from the same list. A range it cannot read is reported as such
 * instead of being guessed at, because the version it picks is the one whose
 * bytes get downloaded.
 */

export type NpmVersionChoice =
  | { readonly status: "chosen"; readonly version: string }
  | { readonly status: "none-published" }
  | { readonly status: "range-unreadable" };

interface Version {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease: ReadonlyArray<string>;
}

interface Comparator {
  readonly operator: "<" | "<=" | ">" | ">=" | "=";
  readonly version: Version;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/;
const TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function parseNpmVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  if (match === null) return undefined;
  return {
    major: BigInt(match[1] ?? "0"),
    minor: BigInt(match[2] ?? "0"),
    patch: BigInt(match[3] ?? "0"),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** Negative when `left` is older than `right`, as semantic versioning orders them. */
export function compareNpmVersions(left: string, right: string): number {
  const a = parseNpmVersion(left);
  const b = parseNpmVersion(right);
  if (a === undefined || b === undefined) return left < right ? -1 : left > right ? 1 : 0;
  return compareParsed(a, b);
}

function compareParsed(a: Version, b: Version): number {
  for (const [x, y] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease.length === 0) return b.prerelease.length === 0 ? 0 : 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function chooseNpmVersion(input: {
  readonly requested: string | undefined;
  readonly published: ReadonlyArray<string>;
  readonly distTags: Readonly<Record<string, string>>;
}): NpmVersionChoice {
  const requested = (input.requested ?? "").trim();
  const wanted = requested === "" ? "latest" : requested;
  const exact = parseNpmVersion(wanted);
  if (exact !== undefined && !wanted.includes("+") && wanted === wanted.replace(/^v/, "")) {
    return input.published.includes(wanted)
      ? { status: "chosen", version: wanted }
      : { status: "none-published" };
  }
  if (TAG.test(wanted) && !/^[xX]$/.test(wanted)) {
    const tagged = input.distTags[wanted];
    return tagged !== undefined && input.published.includes(tagged)
      ? { status: "chosen", version: tagged }
      : { status: "none-published" };
  }
  const alternatives = parseRange(wanted);
  if (alternatives === undefined) return { status: "range-unreadable" };
  let best: { readonly text: string; readonly parsed: Version } | undefined;
  for (const text of input.published) {
    const parsed = parseNpmVersion(text);
    if (parsed === undefined) continue;
    if (!alternatives.some((comparators) => satisfies(parsed, comparators))) continue;
    if (best === undefined || compareParsed(parsed, best.parsed) > 0) best = { text, parsed };
  }
  return best === undefined
    ? { status: "none-published" }
    : { status: "chosen", version: best.text };
}

function satisfies(version: Version, comparators: ReadonlyArray<Comparator>): boolean {
  for (const comparator of comparators) {
    const order = compareParsed(version, comparator.version);
    const held =
      comparator.operator === "<"
        ? order < 0
        : comparator.operator === "<="
          ? order <= 0
          : comparator.operator === ">"
            ? order > 0
            : comparator.operator === ">="
              ? order >= 0
              : order === 0;
    if (!held) return false;
  }
  // A prerelease satisfies a range only when the range itself names a
  // prerelease of the same major, minor, and patch.
  if (version.prerelease.length === 0) return true;
  return comparators.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 &&
      comparator.version.major === version.major &&
      comparator.version.minor === version.minor &&
      comparator.version.patch === version.patch,
  );
}

function parseRange(text: string): ReadonlyArray<ReadonlyArray<Comparator>> | undefined {
  const alternatives: Array<ReadonlyArray<Comparator>> = [];
  for (const part of text.split("||")) {
    const comparators = parseComparatorSet(part.trim());
    if (comparators === undefined) return undefined;
    alternatives.push(comparators);
  }
  return alternatives;
}

function parseComparatorSet(text: string): ReadonlyArray<Comparator> | undefined {
  if (text === "") return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen !== null) {
    const lower = desugar("", hyphen[1] ?? "", "lower");
    const upper = desugar("", hyphen[2] ?? "", "upper");
    return lower === undefined || upper === undefined ? undefined : [...lower, ...upper];
  }
  // `>= 1.2.0` with a space after the operator is the same comparator.
  const tokens = text.replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1").split(/\s+/);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const match = /^(<=|>=|<|>|=|\^|~)?(.*)$/.exec(token);
    const desugared = desugar(match?.[1] ?? "", match?.[2] ?? "", "whole");
    if (desugared === undefined) return undefined;
    comparators.push(...desugared);
  }
  return comparators;
}

/** Turns one operator and partial version into plain comparators, or undefined when unreadable. */
function desugar(
  operator: string,
  text: string,
  hyphenEnd: "lower" | "upper" | "whole",
): ReadonlyArray<Comparator> | undefined {
  const match = PARTIAL.exec(text);
  if (match === null) return undefined;
  const wildcard = (value: string | undefined) =>
    value === undefined || value === "x" || value === "X" || value === "*";
  const major = wildcard(match[1]) ? undefined : BigInt(match[1] ?? "0");
  const minor = major === undefined || wildcard(match[2]) ? undefined : BigInt(match[2] ?? "0");
  const patch = minor === undefined || wildcard(match[3]) ? undefined : BigInt(match[3] ?? "0");
  const prerelease = match[4] === undefined || patch === undefined ? [] : match[4].split(".");
  const make = (a: bigint, b: bigint, c: bigint, pre: ReadonlyArray<string> = []): Version => ({
    major: a,
    minor: b,
    patch: c,
    prerelease: pre,
  });
  const atLeast = (version: Version): Comparator => ({ operator: ">=", version });
  const below = (version: Version): Comparator => ({ operator: "<", version });
  if (major === undefined) {
    // `*`, `x`: any version. A bare `>` or `<` over everything matches nothing useful.
    return operator === "" || operator === "=" || operator === ">=" || operator === "<="
      ? []
      : undefined;
  }
  const floor = make(major, minor ?? 0n, patch ?? 0n, prerelease);
  const nextUp =
    minor === undefined
      ? make(major + 1n, 0n, 0n)
      : patch === undefined
        ? make(major, minor + 1n, 0n)
        : undefined;
  if (operator === "^") {
    if (major > 0n || minor === undefined) return [atLeast(floor), below(make(major + 1n, 0n, 0n))];
    if (minor > 0n || patch === undefined) return [atLeast(floor), below(make(0n, minor + 1n, 0n))];
    return [atLeast(floor), below(make(0n, 0n, patch + 1n))];
  }
  if (operator === "~") {
    return [
      atLeast(floor),
      below(minor === undefined ? make(major + 1n, 0n, 0n) : make(major, minor + 1n, 0n)),
    ];
  }
  if (operator === "" || operator === "=") {
    if (hyphenEnd === "upper") {
      return nextUp === undefined ? [{ operator: "<=", version: floor }] : [below(nextUp)];
    }
    if (hyphenEnd === "lower") return [atLeast(floor)];
    return nextUp === undefined
      ? [{ operator: "=", version: floor }]
      : [atLeast(floor), below(nextUp)];
  }
  if (operator === ">") {
    return nextUp === undefined ? [{ operator: ">", version: floor }] : [atLeast(nextUp)];
  }
  if (operator === ">=") return [atLeast(floor)];
  if (operator === "<") return [below(floor)];
  return nextUp === undefined ? [{ operator: "<=", version: floor }] : [below(nextUp)];
}

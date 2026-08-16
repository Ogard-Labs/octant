export type CodeDeepLink =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{ kind: "thread"; threadId: string }>
  | Readonly<{
      kind: "file";
      threadId: string;
      checkoutId: string;
      fileId: string;
      relativePath: string;
      line: number;
      column: number;
    }>
  | Readonly<{ kind: "diff"; threadId: string; checkoutId: string }>
  | Readonly<{ kind: "test"; threadId: string; testRunId: string }>
  | Readonly<{ kind: "new-thread"; projectId: string; checkoutId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCodeDeepLink(input: string): CodeDeepLink {
  try {
    if (/%5c/i.test(input)) return invalid();
    const url = new URL(input);
    if (
      url.protocol !== "octant:" ||
      url.hostname !== "code" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return invalid();
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "project" && segments.length === 2 && noQuery(url)) {
      return { kind: "project", projectId: uuid(segments[1]) };
    }
    if (segments[0] === "thread" && segments.length === 2 && noQuery(url)) {
      return { kind: "thread", threadId: uuid(segments[1]) };
    }
    if (segments[0] === "diff" && segments.length === 3 && noQuery(url)) {
      return { kind: "diff", threadId: uuid(segments[1]), checkoutId: uuid(segments[2]) };
    }
    if (segments[0] === "test" && segments.length === 3 && noQuery(url)) {
      return { kind: "test", threadId: uuid(segments[1]), testRunId: uuid(segments[2]) };
    }
    if (segments[0] === "file" && segments.length === 4) {
      exactQuery(url, ["path", "line", "column"]);
      return {
        kind: "file",
        threadId: uuid(segments[1]),
        checkoutId: uuid(segments[2]),
        fileId: uuid(segments[3]),
        relativePath: relativePath(url.searchParams.get("path")),
        line: positive(url.searchParams.get("line")),
        column: positive(url.searchParams.get("column")),
      };
    }
    if (segments[0] === "new" && segments.length === 1) {
      exactQuery(url, ["projectId", "checkoutId"]);
      return {
        kind: "new-thread",
        projectId: uuid(url.searchParams.get("projectId")),
        checkoutId: uuid(url.searchParams.get("checkoutId")),
      };
    }
  } catch {
    return invalid();
  }
  return invalid();
}

function uuid(value: string | null | undefined): string {
  if (value === null || value === undefined || !UUID.test(value)) return invalid();
  return value.toLowerCase();
}

function positive(value: string | null): number {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return invalid();
  return parsed;
}

function relativePath(value: string | null): string {
  if (
    value === null ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  )
    return invalid();
  return value;
}

function noQuery(url: URL): boolean {
  if ([...url.searchParams].length > 0) return invalid();
  return true;
}

function exactQuery(url: URL, keys: ReadonlyArray<string>): void {
  const actual = [...url.searchParams.keys()];
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) invalid();
}

function invalid(): never {
  throw new TypeError("Octant rejected an invalid Code deep link.");
}

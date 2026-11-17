import { realpathSync } from "node:fs";

export interface ProcessConfinementAccountRootInput {
  readonly boundRoot: string;
  readonly temporaryDirectory: string;
  readonly ownAccountPaths?: ReadonlyArray<string>;
  readonly ownAccountAccess?: "none";
  readonly policyFolderRoots?: ReadonlyArray<string>;
}

function rootForms(path: string): ReadonlyArray<string> {
  try {
    const resolved = realpathSync(path);
    return resolved === path ? [path] : [path, resolved];
  } catch {
    return [path];
  }
}

/** Provider-account exemptions exclude every folder granted by Strict policy. */
export function processConfinementAccountRoots(
  input: ProcessConfinementAccountRootInput,
  readRoots: ReadonlyArray<string>,
  additionalWriteRoots: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (input.ownAccountAccess === "none") return [];
  const shared = new Set([
    ...rootForms(input.boundRoot),
    ...rootForms(input.temporaryDirectory),
    ...(input.policyFolderRoots ?? []).flatMap(rootForms),
  ]);
  return [
    ...new Set([
      ...(input.ownAccountPaths ?? []),
      ...[...readRoots, ...additionalWriteRoots].filter(
        (path) => !rootForms(path).some((form) => shared.has(form)),
      ),
    ]),
  ];
}

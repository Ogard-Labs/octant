import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  NO_PROTECTED_FILES_CHANGES,
  protectedEntryFor,
  resolveProtectedFiles,
} from "@octant/domain/secret-guard-policy";
import { secretGuardRefusal, secretGuardPlatform } from "../process/secretGuard";
import {
  decodeOwnerApprovalAction,
  type OwnerApprovalAction,
} from "@octant/contracts/owner-approvals";

/** Recovery covers files within the live bound root, never credential or Git administration paths. */
export function ownerApprovalFileContext(
  action: OwnerApprovalAction,
  root: string | undefined,
):
  | {
      readonly physicalRoot: string;
      readonly device: string;
      readonly inode: string;
      readonly physicalPath: string;
    }
  | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  if (root === undefined || !isAbsolute(root)) return undefined;
  try {
    const input: unknown = JSON.parse(action.input);
    if (
      typeof input !== "object" ||
      input === null ||
      !("file_path" in input) ||
      typeof input.file_path !== "string" ||
      !isAbsolute(input.file_path)
    )
      return undefined;
    const path = resolve(input.file_path);
    const credentialName = (candidate: string) =>
      candidate
        .split(/[\\/]/)
        .some((part) =>
          /^(?:\.env(?:\..*)?|\.(?:ssh|aws|azure|npmrc|netrc|pypirc)|credentials(?:\.json)?|auth\.json)$/i.test(
            part,
          ),
        );
    if (credentialName(path)) return undefined;
    const physicalRoot = realpathSync(root);
    let physicalPath: string;
    try {
      physicalPath = realpathSync(path);
    } catch (error) {
      // Only an absent leaf may become a new ordinary file. A dangling link
      // also fails realpath, but writing it would follow its unresolved target.
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT" ||
        lstatSync(path, { throwIfNoEntry: false }) !== undefined
      )
        return undefined;
      physicalPath = join(realpathSync(dirname(path)), basename(path));
    }
    if (credentialName(physicalPath)) return undefined;
    const inside = (candidate: string) => {
      const part = relative(physicalRoot, candidate);
      return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
    };
    if (
      !inside(physicalPath) ||
      [path, physicalPath].some((candidate) =>
        candidate.split(/[\\/]/).some((part) => part.toLowerCase() === ".git"),
      )
    )
      return undefined;
    // Built-in credential exclusions remain exclusions even if the host removed
    // a sandbox rule. Its active extra rules and resolved aliases are checked too.
    const builtins = resolveProtectedFiles(
      { platform: secretGuardPlatform(process.platform), home: homedir() },
      NO_PROTECTED_FILES_CHANGES,
    );
    if (
      protectedEntryFor([path, physicalPath], builtins) !== undefined ||
      secretGuardRefusal(path) !== undefined
    )
      return undefined;
    const rootStat = statSync(physicalRoot, { bigint: true });
    if (!rootStat.isDirectory()) return undefined;
    return {
      physicalRoot,
      device: String(rootStat.dev),
      inode: String(rootStat.ino),
      physicalPath,
    };
  } catch {
    return undefined;
  }
}

/** Shell remains inside its runtime confinement; directory facts do not authorize command effects. */
export function ownerApprovalContext(action: OwnerApprovalAction, root: string | undefined) {
  if (action.kind !== "shell") return ownerApprovalFileContext(action, root);
  if (root === undefined || action.workingDirectory === undefined) return undefined;
  try {
    // Supported adapters attest the admitted root itself, never a guessed current directory.
    if (action.workingDirectory !== root) return undefined;
    const context = ownerApprovalFileContext(
      decodeOwnerApprovalAction({
        kind: "file-read",
        tool: "Read",
        input: JSON.stringify({ file_path: action.workingDirectory }),
      }),
      root,
    );
    if (context === undefined || context.physicalPath !== context.physicalRoot) return undefined;
    return context;
  } catch {
    return undefined;
  }
}

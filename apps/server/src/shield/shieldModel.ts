import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  decodeProviderSessionId,
  type ProviderInstanceId,
  type ProviderModelId,
  type ShieldModelChoice,
} from "@octant/contracts";
import { smallestShieldModel } from "@octant/domain/shield-judge-policy";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { completeOnceOutcome } from "../harness/nativeHarnessSingleShot";
import type { ShieldModelPort } from "./octantShield";

/**
 * The model that judges a thread: the person's chosen endpoint, else the
 * thread's own provider account with that provider's smallest model, else the
 * thread's own model. Using the thread's own account by default means no new
 * party sees the work.
 */
export function resolveShieldModel(input: {
  readonly chosen?: ShieldModelChoice | undefined;
  readonly thread: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  };
  readonly catalog: (
    providerInstanceId: ProviderInstanceId,
  ) => ReadonlyArray<{ readonly id: ProviderModelId; readonly displayName: string }> | undefined;
}): ShieldModelChoice {
  if (input.chosen !== undefined) return input.chosen;
  const models = input.catalog(input.thread.providerInstanceId) ?? [];
  const smallest = smallestShieldModel(models);
  return {
    providerInstanceId: input.thread.providerInstanceId,
    modelId: smallest?.id ?? input.thread.modelId,
  };
}

/**
 * A Shield model over a configured provider driver: one tool-less one-shot
 * session started in a scratch folder outside every Project, so the model can
 * reach none of the thread's files, shell, or network.
 */
export function createShieldModelPort(input: {
  readonly model: ShieldModelChoice;
  readonly driver: ProviderDriver;
  readonly scratchRoot: string;
  readonly uuid: () => string;
  readonly complete?: typeof completeOnceOutcome;
}): ShieldModelPort {
  return {
    model: input.model,
    complete: async ({ instructions, prompt, timeoutMs }) => {
      const outcome = await (input.complete ?? completeOnceOutcome)({
        driver: input.driver,
        providerInstanceId: input.model.providerInstanceId,
        modelId: input.model.modelId,
        sessionId: decodeProviderSessionId(input.uuid()),
        projectRoot: input.scratchRoot,
        instructions,
        prompt,
        timeoutMs,
      });
      if (outcome.status === "completed") return { status: "answered", text: outcome.text };
      if (outcome.status === "timed-out") return { status: "timed-out" };
      if (outcome.status === "failed") return { status: "failed" };
      return { status: "unreached" };
    },
  };
}

const MAX_PACKAGE_JSON_BYTES = 1_048_576;
const PROJECT_SCRIPTS = ["test", "build", "typecheck", "lint"] as const;

/**
 * The Project's own test and build commands, read from the files at its root:
 * `package.json` scripts under the package manager its lockfile names, and the
 * standard commands of a Cargo, Swift, or Go package. A root without any of
 * these has none, and its commands go to the model.
 */
export function projectCommandsIn(root: string): ReadonlyArray<string> {
  const commands: string[] = [];
  const exists = (name: string) => {
    try {
      return statSync(join(root, name)).isFile();
    } catch {
      return false;
    }
  };
  const scripts = packageScripts(root);
  if (scripts.length > 0) {
    const manager =
      exists("bun.lock") || exists("bun.lockb")
        ? "bun"
        : exists("pnpm-lock.yaml")
          ? "pnpm"
          : exists("yarn.lock")
            ? "yarn"
            : "npm";
    for (const script of PROJECT_SCRIPTS) {
      if (!scripts.includes(script)) continue;
      commands.push(`${manager} run ${script}`);
      if (script === "test") commands.push(`${manager} test`);
    }
  }
  if (exists("Cargo.toml")) commands.push("cargo test", "cargo build", "cargo check");
  if (exists("Package.swift")) commands.push("swift build", "swift test");
  if (exists("go.mod")) commands.push("go test ./...", "go build ./...", "go vet ./...");
  return commands;
}

function packageScripts(root: string): ReadonlyArray<string> {
  try {
    const path = join(root, "package.json");
    if (statSync(path).size > MAX_PACKAGE_JSON_BYTES) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const scripts = (parsed as { readonly scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return [];
    return Object.keys(scripts);
  } catch {
    return [];
  }
}

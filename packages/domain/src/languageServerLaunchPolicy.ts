import type { CodeLanguageRefusalReason } from "@octant/contracts/code-language";
import type { ExtensionLanguageServerClass } from "@octant/contracts/extensions";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type { PrincipalKind } from "./remoteAccessPolicy";

/**
 * Whether a language server may start for a Code checkout, and how it is
 * confined if it may. Canonical: docs/design/language-services.md § Launch
 * classes.
 *
 * The decision reads only the component's declared class and the facts of
 * this start. Nothing from the repository reaches it, so no file in the
 * checkout can pick a wider class. Authority over the thread, checkout, and
 * file is checked separately on every read; this decides the launch alone.
 */

/** `other` is any host platform that is neither macOS nor Linux. */
export type LanguageServerHostPlatform = "macos" | "linux" | "windows" | "other";

export interface LanguageServerLaunchRequest {
  readonly launchClass: ExtensionLanguageServerClass;
  /** The posture of the Code thread whose read starts the server. */
  readonly posture: ProviderExecutionPolicy;
  readonly platform: LanguageServerHostPlatform;
  /**
   * Who caused the start: a local window, or anything that is not the person
   * at the machine (a paired device's read, or an agent's tool call).
   */
  readonly startedBy: PrincipalKind;
  /**
   * The shell-command approval for this checkout and component. Only a
   * `repo-tooling` start reads it; a `static` server falls in no approval
   * category.
   */
  readonly shellCommandApproval: "granted" | "absent";
}

export type LanguageServerLaunchShape =
  | {
      readonly launchClass: "static";
      readonly confinement: "seatbelt" | "bubblewrap";
      readonly checkout: "read-only";
      readonly toolchainRoots: "none";
      readonly writes: "private-cache";
      readonly execution: "own-binary-only";
      /** Linux loads the no-fork filter Plan already uses; Seatbelt denies exec instead. */
      readonly forkFilter: "seccomp-no-fork" | "none";
      readonly network: "none";
    }
  | {
      readonly launchClass: "repo-tooling";
      readonly confinement: "seatbelt" | "bubblewrap";
      readonly checkout: "read-write";
      readonly toolchainRoots: "declared";
      readonly writes: "checkout-and-private-cache";
      readonly execution: "confined-as-terminal";
      readonly forkFilter: "none";
      /**
       * The Code Project's egress rules, not a thread's: the server serves
       * the checkout, not the thread that happened to start it.
       */
      readonly network: "proxied-under-project-rules";
    };

/** A launch refusal reaches the editor unchanged as a language read refusal. */
export type LanguageServerLaunchRefusal = Extract<
  CodeLanguageRefusalReason,
  "unsupported-platform" | "plan-read-only" | "local-host-required" | "approval-required"
>;

export type LanguageServerLaunchDecision =
  | { readonly status: "launch"; readonly shape: LanguageServerLaunchShape }
  | { readonly status: "refused"; readonly reason: LanguageServerLaunchRefusal };

export function decideLanguageServerLaunch(
  request: LanguageServerLaunchRequest,
): LanguageServerLaunchDecision {
  if (request.platform !== "macos" && request.platform !== "linux") {
    return { status: "refused", reason: "unsupported-platform" };
  }
  const confinement = request.platform === "macos" ? "seatbelt" : "bubblewrap";
  if (request.launchClass === "static") {
    return {
      status: "launch",
      shape: {
        launchClass: "static",
        confinement,
        checkout: "read-only",
        toolchainRoots: "none",
        writes: "private-cache",
        execution: "own-binary-only",
        forkFilter: request.platform === "linux" ? "seccomp-no-fork" : "none",
        network: "none",
      },
    };
  }
  if (request.posture === "plan") return { status: "refused", reason: "plan-read-only" };
  // Running the repository's tooling on the host stays with the person at the
  // machine, as terminal input does, so an approval on record does not let a
  // paired device start one.
  if (request.startedBy !== "local-window") {
    return { status: "refused", reason: "local-host-required" };
  }
  if (request.shellCommandApproval !== "granted") {
    return { status: "refused", reason: "approval-required" };
  }
  return {
    status: "launch",
    shape: {
      launchClass: "repo-tooling",
      confinement,
      checkout: "read-write",
      toolchainRoots: "declared",
      writes: "checkout-and-private-cache",
      execution: "confined-as-terminal",
      forkFilter: "none",
      network: "proxied-under-project-rules",
    },
  };
}

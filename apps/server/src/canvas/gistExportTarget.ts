import type { GithubAuthenticationSnapshot } from "@octant/contracts/github-onboarding";
import {
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportReceipt,
  type CanvasExportDelivery,
  type CanvasExportRefusal,
} from "@octant/contracts/canvas-export";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import { canvasExportPlannedName } from "@octant/domain";
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import type { GistCreationPort } from "../github/gistCreationPort";

/**
 * Publishing a rendered Canvas as a GitHub Gist.
 *
 * This rides the same published export port a third-party destination does: it
 * declares a contribution, describes what the person is approving, and is
 * called only after approval. It reuses the GitHub connection Octant already
 * has — the host-managed credential the `gh` command resolves, never a token
 * read here — so a host with no usable connection reports `not-connected` and
 * one whose credential is stored insecurely reports `refused`. The gist is
 * secret unless the person chooses public on the card, and the card says so.
 *
 * v1 writes Markdown only. A gist is one file, and the rendered Markdown is
 * already redacted by the share filter before it arrives; the target re-checks
 * the whole document, because a payload that still carries a path or a
 * secret-shaped value is refused rather than published.
 */

export const GIST_EXPORT_TARGET_ID = "github-gist";
export const GIST_EXPORT_TARGET_LABEL = "GitHub Gist";

/** The note the card shows so a public choice is made knowingly. */
export const GIST_PUBLIC_NOTE = "A public gist is visible to anyone on the internet.";

/** What the GitHub connection can do for this destination, read synchronously. */
export type GistExportAvailability =
  | { readonly kind: "ready"; readonly account: string }
  | { readonly kind: "not-connected" }
  | { readonly kind: "refused"; readonly reason: string };

export interface GistExportTargetDependencies {
  /** Whether GitHub is connected, and as whom. Read while the offer is built. */
  readonly availability: () => GistExportAvailability;
  readonly gists: GistCreationPort;
}

function refused(code: CanvasExportRefusal["code"], message: string): CanvasExportDelivery {
  return { kind: "refused", code, message };
}

/**
 * The destination's honest state from the GitHub authentication snapshot.
 *
 * An insecure credential store is `refused` rather than `not-connected`: the
 * connection exists but the host will not act through a plaintext token, which
 * is the same rule the other GitHub capabilities follow. Everything else that
 * cannot produce an account — unauthorized, rate-limited, an external token,
 * an unavailable host — is `not-connected`.
 */
export function gistExportAvailability(
  snapshot: GithubAuthenticationSnapshot,
): GistExportAvailability {
  if (snapshot.state === "insecure-storage") {
    return {
      kind: "refused",
      reason: "GitHub is signed in with credentials stored in plain text on this Mac.",
    };
  }
  if (
    (snapshot.state === "ready" || snapshot.state === "scope-limited") &&
    snapshot.account !== undefined
  ) {
    return { kind: "ready", account: snapshot.account.login };
  }
  return { kind: "not-connected" };
}

/**
 * The GitHub connection state the gist destination offers from, read on demand.
 *
 * The offer list is built synchronously and cannot wait on `gh`, so the state
 * is kept here. It is read only when an export lists or prepares destinations —
 * nothing calls GitHub at host start — and kept until Octant's own GitHub
 * commands report a change. A state that cannot offer the gist is read again
 * the next time, so connecting GitHub outside Octant is picked up.
 */
export class GistConnection {
  readonly #read: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;
  #snapshot: GithubAuthenticationSnapshot | undefined;
  #reading: Promise<void> | undefined;
  // Bumped by every reported change, so a read that started before the change
  // cannot overwrite the newer state when it lands.
  #generation = 0;

  constructor(read: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>) {
    this.#read = read;
  }

  availability(): GistExportAvailability {
    return this.#snapshot === undefined
      ? { kind: "not-connected" }
      : gistExportAvailability(this.#snapshot);
  }

  /** Reads the connection unless the kept state can already offer the gist. */
  refresh(): Promise<void> {
    if (this.availability().kind !== "not-connected") return Promise.resolve();
    if (this.#reading !== undefined) return this.#reading;
    const generation = this.#generation;
    const reading = this.#read(new AbortController().signal)
      .then(
        (snapshot) => {
          if (generation === this.#generation) this.#snapshot = snapshot;
        },
        // A failed read leaves the destination not-connected; the next
        // listing tries again.
        () => undefined,
      )
      .finally(() => {
        this.#reading = undefined;
      });
    this.#reading = reading;
    return reading;
  }

  /** Records the state an Octant GitHub command just produced. */
  changed(snapshot: GithubAuthenticationSnapshot): void {
    this.#generation += 1;
    this.#snapshot = snapshot;
  }
}

export function createGistExportTarget(
  dependencies: GistExportTargetDependencies,
): CanvasExportTarget {
  return {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: GIST_EXPORT_TARGET_ID,
      label: GIST_EXPORT_TARGET_LABEL,
      formats: ["markdown"],
    }),

    describeDestination() {
      const availability = dependencies.availability();
      if (availability.kind !== "ready") return undefined;
      // No path: the gist has no URL until it exists. The account and the
      // audience are what the person can approve in advance, and secret is the
      // default they are asked to leave or change.
      return {
        account: availability.account,
        visibility: "secret",
        note: GIST_PUBLIC_NOTE,
      };
    },

    async exportDocument(output, confirmed) {
      const availability = dependencies.availability();
      if (availability.kind === "not-connected") {
        return refused("not-connected", "GitHub is not connected.");
      }
      if (availability.kind === "refused") return refused("refused", availability.reason);
      if (output.format !== "markdown") {
        return refused("unsupported-format", "A gist export is Markdown only.");
      }
      // The share filter is the same one every exported document passes: no
      // absolute paths and no secret-shaped values leave the host. A document
      // that still fails it is refused, never published.
      if (!isCanvasShareSafeText(output.body)) {
        return refused("refused", "The document contains text that cannot leave this Mac.");
      }
      const visibility = confirmed?.visibility === "public" ? "public" : "secret";
      const fileName = canvasExportPlannedName(output.title, "markdown");
      const outcome = await dependencies.gists.create({
        fileName,
        content: output.body,
        description: output.title,
        visibility,
      });
      if (outcome.kind === "unauthorized") {
        return refused("refused", "GitHub refused the credential. Reconnect GitHub and try again.");
      }
      if (outcome.kind === "rejected") {
        return refused(
          "refused",
          "GitHub declined to create the gist. Check that the GitHub connection includes the gist scope, then try again.",
        );
      }
      if (outcome.kind === "unavailable") {
        return refused("unavailable", "GitHub could not be reached.");
      }
      return decodeCanvasExportDelivery({
        kind: "receipt",
        receipt: decodeCanvasExportReceipt({
          kind: "link",
          href: outcome.gist.url,
          remoteId: outcome.gist.id,
        }),
      });
    },
  };
}

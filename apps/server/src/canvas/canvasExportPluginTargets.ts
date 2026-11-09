import type { ExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import type { CanvasExportTargetBinding } from "./canvasExportService";
import {
  runCanvasExportWorker,
  type CanvasExportWorkerProcessOptions,
} from "./canvasExportWorkerProcess";

function candidates(snapshot: ExtensionEffectiveSnapshot) {
  return snapshot.packages.flatMap((pkg) =>
    pkg.components.flatMap((state) => {
      const declaration = state.component.canvasExport;
      if (
        state.component.kind !== "canvas-export-target" ||
        declaration === undefined ||
        state.effectiveState.kind !== "effective" ||
        pkg.activationVersion === undefined
      )
        return [];
      return [
        {
          reference: {
            extensionId: String(pkg.extensionId),
            packageId: String(pkg.packageId),
            version: String(pkg.version),
            digest: String(pkg.digest),
          },
          componentId: String(state.component.id),
          declaration,
          identity: JSON.stringify([
            pkg.extensionId,
            pkg.packageId,
            pkg.version,
            pkg.digest,
            state.component.id,
            pkg.activationVersion,
            snapshot.scope,
            state.policy.revision,
            state.policy.hostAllowed,
            state.policy.modeAllowed,
            state.policy.projectAllowed,
            state.policy.threadAllowed,
            state.policy.policyAllowed,
          ]),
          facts: {
            installed: state.activation.installed,
            trusted: state.activation.trusted,
            desiredEnabled: state.activation.pluginDesired && state.activation.componentDesired,
            effectiveState: state.effectiveState,
            connected: true,
          },
        },
      ];
    }),
  );
}

/** Reads fresh effective facts; executable package code never enters the server process. */
export function canvasExportPluginTargets(
  options: CanvasExportWorkerProcessOptions,
  snapshot: () => ExtensionEffectiveSnapshot | undefined,
): ReadonlyArray<CanvasExportTargetBinding> {
  const currentSnapshot = snapshot();
  if (currentSnapshot === undefined) return [];
  return candidates(currentSnapshot).map((candidate) => {
    const current = () => {
      const latest = snapshot();
      return (
        latest !== undefined &&
        candidates(latest).some((value) => value.identity === candidate.identity)
      );
    };
    const invoke = (
      phase: "describe" | "export",
      output: Parameters<typeof runCanvasExportWorker>[1]["output"],
      confirmed?: Parameters<typeof runCanvasExportWorker>[1]["confirmed"],
    ) =>
      runCanvasExportWorker(options, {
        reference: candidate.reference,
        componentId: candidate.componentId,
        current,
        allowedOrigins: candidate.declaration.allowedOrigins,
        phase,
        output,
        ...(confirmed === undefined ? {} : { confirmed }),
      });
    return {
      identity: candidate.identity,
      facts: candidate.facts,
      target: {
        contribution: candidate.declaration.contribution,
        describeDestination: async (output) => {
          const response = await invoke("describe", output);
          if (
            response.kind !== "description" ||
            response.destination?.path !== undefined ||
            response.destination?.alsoReplaces !== undefined
          )
            throw new Error("Export destination unavailable.");
          const network =
            candidate.declaration.allowedOrigins.length === 0
              ? "No network destinations."
              : `Network destinations: ${candidate.declaration.allowedOrigins.join(", ")}.`;
          return {
            ...response.destination,
            note: `${network}${response.destination?.note === undefined ? "" : ` ${response.destination.note}`}`,
          };
        },
        exportDocument: async (output, confirmed) => {
          const response = await invoke("export", output, confirmed);
          return response.kind === "delivery"
            ? response.delivery
            : {
                kind: "refused",
                code: "unavailable",
                message: "The destination did not confirm completion. Check it before retrying.",
              };
        },
      },
    };
  });
}

import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderResumeCursor,
  ProviderSessionId,
} from "@octant/contracts";

export type ProviderResumeBinding = NonNullable<ProviderResumeCursor["binding"]>;

/**
 * What a provider-owned session was opened for, recorded in its resume cursor
 * when it starts. The host journals the cursor with the turn, so the record
 * survives a restart and travels with the session it names; the runtime's own
 * session id alone says nothing about the Octant session, folder, or mode it
 * belongs to.
 */
export function providerResumeBinding(input: {
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly projectRoot: string;
  /** A connection acquired without a mode runs Code's posture. */
  readonly mode: "chat" | "work" | "code" | undefined;
  readonly modelId: ProviderModelId;
}): ProviderResumeBinding {
  return {
    instanceId: input.instanceId,
    sessionId: input.sessionId,
    projectRoot: input.projectRoot,
    mode: input.mode ?? "code",
    modelId: input.modelId,
  };
}

/**
 * Whether a resume must be refused because the cursor's recorded binding
 * names another provider instance, Octant session, folder, or mode, or, for
 * a driver that cannot carry a session onto another model, another model.
 *
 * A cursor without a binding predates the record; the driver's own checks of
 * the runtime's session (its folder, its history) still decide it.
 */
export function resumeBindingRefuses(
  cursor: ProviderResumeCursor,
  expected: {
    readonly instanceId: ProviderInstanceId;
    readonly sessionId: ProviderSessionId;
    readonly projectRoot: string;
    readonly mode: "chat" | "work" | "code" | undefined;
    /** Set only by a driver whose sessions keep the model they were opened with. */
    readonly fixedModelId?: ProviderModelId | undefined;
  },
): boolean {
  const binding = cursor.binding;
  if (binding === undefined) return false;
  return (
    String(binding.instanceId) !== String(expected.instanceId) ||
    String(binding.sessionId) !== String(expected.sessionId) ||
    binding.projectRoot !== expected.projectRoot ||
    binding.mode !== (expected.mode ?? "code") ||
    (expected.fixedModelId !== undefined &&
      String(binding.modelId) !== String(expected.fixedModelId))
  );
}

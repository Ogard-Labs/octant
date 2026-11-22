import { providerTerminalName, type PickerGroup } from "@octant/domain";

/**
 * The provider program a thread's terminal tabs can open, named for the
 * person. Only a provider with its own command-line program offers one, and
 * Plan, which starts no terminal, offers none; the host decides again.
 */
export function providerTerminalOffer(
  providerGroups: ReadonlyArray<PickerGroup> | undefined,
  thread: { readonly providerInstanceId: string; readonly executionPolicy: string },
): { readonly providerProgramName?: string } {
  if (thread.executionPolicy === "plan") return {};
  const instance = providerGroups?.find(
    (group) => String(group.instance.id) === String(thread.providerInstanceId),
  )?.instance;
  const name =
    instance === undefined || !instance.enabled
      ? undefined
      : providerTerminalName(instance.driverKind);
  return name === undefined ? {} : { providerProgramName: name };
}

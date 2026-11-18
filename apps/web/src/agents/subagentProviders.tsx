import type { ProviderInstance, ProviderObservedState } from "@octant/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import type { SubagentProviderIdentity } from "./AgentRunDependencyGraph";

/**
 * What every subagent list needs to name what ran a subagent: the provider
 * instances (for the logo and name), the models they describe (for the name
 * the picker shows), and whether the person has turned provider marks off.
 * One value, provided once, so the dock, the composer card, the Environment
 * row and the Agents centre read a run the same way.
 */
interface SubagentProvidersValue {
  readonly providers: ReadonlyMap<string, SubagentProviderIdentity> | undefined;
  readonly showMarks: boolean;
}

const SubagentProvidersContext = createContext<SubagentProvidersValue>({
  providers: undefined,
  showMarks: true,
});

export function SubagentProvidersProvider(props: {
  readonly instances: ReadonlyArray<ProviderInstance> | undefined;
  readonly observedByInstance: ReadonlyMap<ProviderInstance["id"], ProviderObservedState>;
  /** The "Provider icons in thread list" setting. */
  readonly showMarks: boolean;
  readonly children: ReactNode;
}) {
  const { instances, observedByInstance, showMarks } = props;
  const value = useMemo<SubagentProvidersValue>(
    () => ({
      providers:
        instances === undefined
          ? undefined
          : new Map(
              instances.map((instance) => [
                String(instance.id),
                {
                  driverKind: instance.driverKind,
                  displayName: instance.displayName,
                  models: new Map(
                    (observedByInstance.get(instance.id)?.models ?? []).map((model) => [
                      String(model.id),
                      model.displayName,
                    ]),
                  ),
                },
              ]),
            ),
      showMarks,
    }),
    [instances, observedByInstance, showMarks],
  );
  return <SubagentProvidersContext value={value}>{props.children}</SubagentProvidersContext>;
}

/** The provider instances a surface was given, else the ones the app provides. */
export function useSubagentProviders(
  given?: ReadonlyMap<string, SubagentProviderIdentity>,
): ReadonlyMap<string, SubagentProviderIdentity> | undefined {
  const provided = useContext(SubagentProvidersContext).providers;
  return given ?? provided;
}

/**
 * The provider's logo for a subagent row, drawn only for a provider the host
 * reported and the surface knows, and only while the person keeps provider
 * marks on. The words (provider and model) stay in the row's name, so the
 * logo is decoration.
 */
export function SubagentProviderMark(props: {
  readonly providerName: string;
  readonly driverKind: string | undefined;
  readonly size: 12 | 14;
  readonly className?: string;
}) {
  const showMarks = useContext(SubagentProvidersContext).showMarks;
  if (!showMarks || props.driverKind === undefined) return null;
  return (
    <ProviderGlyph
      displayName={props.providerName}
      driverKind={props.driverKind}
      size={props.size}
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}

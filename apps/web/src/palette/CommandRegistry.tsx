import { createContext, useContext, type ReactNode } from "react";
import type { OctantCommand } from "./commandModel";

const NO_COMMANDS: ReadonlyArray<OctantCommand> = [];

const OctantCommandContext = createContext<ReadonlyArray<OctantCommand>>(NO_COMMANDS);

/**
 * Publishes the host-derived command list to every surface that offers
 * commands. It is mounted once, at the App level, next to the state the
 * commands close over.
 */
export function OctantCommandProvider(props: {
  readonly commands: ReadonlyArray<OctantCommand>;
  readonly children: ReactNode;
}) {
  return (
    <OctantCommandContext.Provider value={props.commands}>
      {props.children}
    </OctantCommandContext.Provider>
  );
}

/**
 * The commands this host offers right now. Without a provider — an isolated
 * component test, or a surface mounted outside the shell — the answer is an
 * empty list, and the consuming surface offers no command affordance at all
 * rather than an entry that would do nothing.
 */
export function useOctantCommands(): ReadonlyArray<OctantCommand> {
  return useContext(OctantCommandContext);
}

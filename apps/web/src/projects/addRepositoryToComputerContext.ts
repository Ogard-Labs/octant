import type { HostId } from "@octant/contracts/host";
import type { ProjectId } from "@octant/contracts/projects";
import { createContext } from "react";

export type OpenRepositoryBootstrap = (
  target: ProjectId | { readonly destinationHostId: HostId },
) => void;

/** Opens the modal to clone a local Code Project onto another paired computer. */
export const AddRepositoryToComputerContext = createContext<OpenRepositoryBootstrap | undefined>(
  undefined,
);

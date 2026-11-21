import type { BenchmarksClient } from "@octant/client-runtime";
import type { BenchmarkSuiteKind, ProjectId } from "@octant/contracts";
import { createContext } from "react";

export const BenchmarkAdviceContext = createContext<
  | {
      readonly client: Pick<BenchmarksClient, "listSuites" | "advice">;
      readonly projects: ReadonlyArray<{
        readonly id: ProjectId;
        readonly type: BenchmarkSuiteKind;
        readonly name: string;
      }>;
    }
  | undefined
>(undefined);

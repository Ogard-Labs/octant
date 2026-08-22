import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { AggregateVersion } from "@octant/contracts/events";
import {
  decodeMemoryEntryId,
  type MemoryCommand,
  type MemoryEntryId,
  type MemoryKind,
  type ProjectId,
  type ProjectMemoryView,
} from "@octant/contracts/projects";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectMemoryStatus } from "./useProjectController";

export interface ProjectMemoryController {
  readonly busy: boolean;
  readonly clear: () => void;
  readonly create: (kind: MemoryKind, content: string) => Promise<boolean>;
  readonly errorMessage?: string;
  readonly load: (projectId: ProjectId) => Promise<void>;
  readonly memory?: ProjectMemoryView;
  readonly retract: (entryId: MemoryEntryId, reason: string) => Promise<boolean>;
  readonly retry: (projectId: ProjectId) => Promise<void>;
  readonly status: ProjectMemoryStatus;
  readonly supersede: (entryId: MemoryEntryId, content: string) => Promise<boolean>;
  readonly transfer: (entryId: MemoryEntryId, destinationProjectId: ProjectId) => Promise<boolean>;
}

/**
 * Project-owned memory for one Overview. Switching Projects drops the previous
 * view before the next fetch settles, so another Project's entries cannot
 * remain on screen while that load is in flight.
 */
export function useProjectMemory(
  client: ProjectClient,
  onChanged?: () => void,
): ProjectMemoryController {
  const [memory, setMemory] = useState<ProjectMemoryView>();
  const [status, setStatus] = useState<ProjectMemoryStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const disclosureGeneration = useRef(0);
  const operation = useRef(false);
  const ownerProjectId = useRef<ProjectId | undefined>(undefined);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      disclosureGeneration.current += 1;
    };
  }, []);

  const clear = useCallback((): void => {
    requestGeneration.current += 1;
    disclosureGeneration.current += 1;
    ownerProjectId.current = undefined;
    setMemory(undefined);
    setErrorMessage(undefined);
    setStatus("idle");
  }, []);

  const load = useCallback(
    async (projectId: ProjectId, reason: "open" | "retry" | "refresh" | "conflict" = "open") => {
      if (ownerProjectId.current !== undefined && ownerProjectId.current !== projectId) {
        setMemory(undefined);
        setErrorMessage(undefined);
      }
      const request = ++requestGeneration.current;
      setStatus(reason === "conflict" ? "conflict-reload" : "loading");
      setErrorMessage(undefined);
      try {
        const view = await client.memory(projectId);
        if (!mounted.current || request !== requestGeneration.current) return;
        setMemory(view);
        ownerProjectId.current = view.projectId;
        setStatus("ready");
        if (reason === "conflict" || reason === "refresh") onChangedRef.current?.();
      } catch (error) {
        if (!mounted.current || request !== requestGeneration.current) return;
        setMemory(undefined);
        ownerProjectId.current = undefined;
        setStatus("error");
        setErrorMessage(failureMessage(error));
      }
    },
    [client],
  );

  const executeMemory = useCallback(
    async (
      command: MemoryCommand,
      visibleProjectId: ProjectId,
      lockAlreadyHeld = false,
      disclosure = disclosureGeneration.current,
    ): Promise<boolean> => {
      if (!lockAlreadyHeld) {
        if (operation.current) return false;
        operation.current = true;
        setBusy(true);
      }
      setErrorMessage(undefined);
      try {
        await client.executeMemory(command);
        if (disclosure !== disclosureGeneration.current) return true;
        await load(visibleProjectId, "refresh");
        if (!mounted.current || disclosure !== disclosureGeneration.current) return true;
        onChangedRef.current?.();
        return true;
      } catch (error) {
        if (!mounted.current || disclosure !== disclosureGeneration.current) return false;
        if (failureCategory(error) === "conflict") {
          await load(visibleProjectId, "conflict");
          return false;
        }
        const message = failureMessage(error);
        setErrorMessage(message);
        return false;
      } finally {
        operation.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [client, load],
  );

  const create = useCallback(
    async (kind: MemoryKind, content: string): Promise<boolean> => {
      if (memory === undefined) return false;
      return executeMemory(
        {
          kind: "create-memory-entry",
          projectId: memory.projectId,
          entryId: decodeMemoryEntryId(crypto.randomUUID()),
          memoryKind: kind,
          content,
          expectedVersion: memoryVersion(memory),
        },
        memory.projectId,
      );
    },
    [executeMemory, memory],
  );

  const supersede = useCallback(
    async (entryId: MemoryEntryId, content: string): Promise<boolean> => {
      if (memory === undefined) return false;
      return executeMemory(
        {
          kind: "supersede-memory-entry",
          projectId: memory.projectId,
          entryId,
          successorEntryId: decodeMemoryEntryId(crypto.randomUUID()),
          content,
          expectedVersion: memoryVersion(memory),
        },
        memory.projectId,
      );
    },
    [executeMemory, memory],
  );

  const retract = useCallback(
    async (entryId: MemoryEntryId, reason: string): Promise<boolean> => {
      if (memory === undefined) return false;
      return executeMemory(
        {
          kind: "retract-memory-entry",
          projectId: memory.projectId,
          entryId,
          reason,
          expectedVersion: memoryVersion(memory),
        },
        memory.projectId,
      );
    },
    [executeMemory, memory],
  );

  const transfer = useCallback(
    async (entryId: MemoryEntryId, destinationProjectId: ProjectId): Promise<boolean> => {
      if (memory === undefined) return false;
      if (operation.current) return false;
      const sourceProjectId = memory.projectId;
      const disclosure = disclosureGeneration.current;
      operation.current = true;
      setBusy(true);
      let destinationMemory: ProjectMemoryView;
      try {
        destinationMemory = await client.memory(destinationProjectId);
      } catch (error) {
        if (mounted.current && disclosure === disclosureGeneration.current) {
          setErrorMessage(failureMessage(error));
        }
        operation.current = false;
        if (mounted.current) setBusy(false);
        return false;
      }
      if (
        !mounted.current ||
        disclosure !== disclosureGeneration.current ||
        ownerProjectId.current !== sourceProjectId
      ) {
        operation.current = false;
        if (mounted.current) setBusy(false);
        return false;
      }
      return executeMemory(
        {
          kind: "transfer-memory-entry",
          sourceProjectId,
          sourceEntryId: entryId,
          destinationProjectId,
          destinationEntryId: decodeMemoryEntryId(crypto.randomUUID()),
          expectedVersion: memoryVersion(destinationMemory),
        },
        sourceProjectId,
        true,
        disclosure,
      );
    },
    [client, executeMemory, memory],
  );

  const retry = useCallback(
    async (projectId: ProjectId) => {
      await load(projectId, "retry");
    },
    [load],
  );

  return {
    busy,
    clear,
    create,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    load,
    ...(memory === undefined ? {} : { memory }),
    retract,
    retry,
    status,
    supersede,
    transfer,
  };
}

function memoryVersion(view: ProjectMemoryView): AggregateVersion {
  return Math.max(
    0,
    ...view.active.map((entry) => entry.version),
    ...view.history.map((entry) => entry.version),
  ) as AggregateVersion;
}

function failureCategory(error: unknown): string {
  return typeof error === "object" && error !== null && "category" in error
    ? String(error.category)
    : "unavailable";
}

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Octant Project service is unavailable.";
}

import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { OctantMode } from "@octant/contracts/modes";
import { useEffect, useMemo, useState } from "react";
import { Surface, SurfaceEmpty, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { ShellState } from "./ShellState";

export interface ArchivedThreadEntry {
  readonly mode: OctantMode;
  readonly projectId?: string;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt?: string;
}

export interface ArchiveProject {
  readonly id: string;
  readonly name: string;
}

export interface ArchiveViewProps {
  readonly chatClient?: Pick<ChatClient, "search">;
  readonly entries: ReadonlyArray<ArchivedThreadEntry>;
  readonly onClose: () => void;
  readonly onOpenThread: (entry: ArchivedThreadEntry) => void;
  readonly projects: ReadonlyArray<ArchiveProject>;
}

type ChatArchiveState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly entries: ReadonlyArray<ArchivedThreadEntry> }
  | { readonly kind: "unavailable" };

const ALL_PROJECTS = "all";
const UNFILED = "unfiled";

export function ArchiveView(props: ArchiveViewProps) {
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);
  const [chatArchive, setChatArchive] = useState<ChatArchiveState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    if (props.chatClient === undefined) {
      setChatArchive({ kind: "unavailable" });
      return () => {
        active = false;
      };
    }
    setChatArchive({ kind: "loading" });
    void props.chatClient
      .search("")
      .then((threads) => {
        if (!active) return;
        setChatArchive({
          kind: "ready",
          entries: threads
            .filter((thread) => thread.lifecycle === "archived")
            .map((thread) => ({
              mode: "chat",
              threadId: String(thread.id),
              title: thread.title,
              ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
              updatedAt: thread.updatedAt,
            })),
        });
      })
      .catch(() => {
        if (active) setChatArchive({ kind: "unavailable" });
      });
    return () => {
      active = false;
    };
  }, [props.chatClient]);

  const entries = useMemo(() => {
    const combined = [
      ...props.entries,
      ...(chatArchive.kind === "ready" ? chatArchive.entries : []),
    ];
    return combined
      .filter((entry) => {
        if (projectFilter === ALL_PROJECTS) return true;
        if (projectFilter === UNFILED) return entry.projectId === undefined;
        return entry.projectId === projectFilter;
      })
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }, [chatArchive, projectFilter, props.entries]);

  const projectNames = useMemo(
    () => new Map(props.projects.map((project) => [project.id, project.name])),
    [props.projects],
  );

  return (
    <Surface ariaLabel="Archive">
      <SurfaceHeader
        actions={
          <OctantSelectField
            aria-label="Filter archive by Project"
            onValueChange={(value) => setProjectFilter(value)}
            options={[
              { id: ALL_PROJECTS, label: "All Projects" },
              { id: UNFILED, label: "Unfiled" },
              ...props.projects.map((project) => ({
                id: project.id,
                label: project.name,
              })),
            ]}
            value={projectFilter}
          />
        }
        onBack={props.onClose}
        subtitle="Threads kept out of active navigation."
        title="Archive"
      />

      {chatArchive.kind === "loading" && props.entries.length === 0 ? (
        <ShellState
          message="Loading archived threads from this host."
          state="loading"
          title="Loading Archive"
        />
      ) : entries.length === 0 ? (
        <SurfaceEmpty
          detail={
            projectFilter === ALL_PROJECTS
              ? "Archived threads will appear here."
              : "No archived threads belong to this Project."
          }
          title="Nothing archived"
        />
      ) : (
        <ul className="surface-list">
          {entries.map((entry) => (
            <li className="surface-row" key={`${entry.mode}:${entry.threadId}`}>
              <OctantButton
                className="archive-view__row"
                onClick={() => props.onOpenThread(entry)}
                type="button"
                variant="ghost"
              >
                <span className="surface-row__copy">
                  <span className="oct-row-label">{entry.title}</span>
                  <span className="oct-meta">
                    {projectNames.get(entry.projectId ?? "") ?? "Unfiled"}
                  </span>
                </span>
                <span className="oct-meta">{modeLabel(entry.mode)}</span>
              </OctantButton>
            </li>
          ))}
        </ul>
      )}

      {chatArchive.kind === "unavailable" ? (
        <p className="oct-meta" role="status">
          Chat archive is temporarily unavailable. Work and Code results are still shown.
        </p>
      ) : null}
    </Surface>
  );
}

function modeLabel(mode: OctantMode): string {
  if (mode === "chat") return "Chat";
  if (mode === "work") return "Work";
  return "Code";
}

import "../styles/files-viewer.css";
import {
  decodeCodeProjectFilePath,
  type CodeCheckoutId,
  type CodeFileChangeNotice,
  type CodeRelativePath,
  type CodeThreadId,
} from "@octant/contracts";
import { checkoutUnreadableReason } from "./checkoutUnreadableReason";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { useEffect } from "react";
import { FolderTree } from "../ui/icons";
import {
  CodeFileExplorer,
  type CodeFileChange,
  type CodeFileExplorerEntry,
} from "./CodeFileExplorer";
import { useCodeFileListingController } from "./useCodeFileListingController";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { OctantAlert } from "../ui/base/OctantAlert";

/**
 * The supported Project folder limit. The client multiplexes these observers
 * with the checkout over one connection, including duplicate panes.
 */
export const MAX_LIVE_EXTRA_FOLDER_WATCHES = 16;

export interface CodeFileExplorerPanelProps {
  readonly threadId?: CodeThreadId | undefined;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly directory?: CodeRelativePath | undefined;
  /** The Project's extra folders, by absolute path, each listed below the checkout. */
  readonly extraFolders?: ReadonlyArray<string> | undefined;
  readonly onOpenFile: (entry: Extract<CodeFileExplorerEntry, { readonly kind: "file" }>) => void;
  readonly selectedPath?: CodeRelativePath | undefined;
  /** Files that differ from the last commit, marked in the checkout's tree. */
  readonly changes?: ReadonlyMap<string, CodeFileChange>;
  /** A double click on a file: keep it open rather than preview it. */
  readonly onKeepFile?: CodeFileExplorerPanelProps["onOpenFile"];
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly client?: CodeFileListingClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Called for every host-reported change, so an open editor can reload. */
  readonly onFilesChanged?: (notice: CodeFileChangeNotice) => void;
  /**
   * Told when the checkout's listing fails and when it reads again, so the
   * pane around the tree can give the whole of itself to the one state.
   */
  readonly onUnavailableChange?: (unavailable: boolean) => void;
}

/**
 * Mountable container for the repository file explorer.
 *
 * A Code thread without a resolved checkout has no repository to list, so the
 * panel says so rather than rendering an empty tree that looks like an empty
 * repository. Truncation and failure are stated in words next to an icon, never
 * signalled by colour alone.
 */
export function CodeFileExplorerPanel(props: CodeFileExplorerPanelProps) {
  const bound = props.threadId !== undefined && props.checkoutId !== undefined;
  const controller = useCodeFileListingController({
    enabled: bound,
    watch: true,
    ...(props.onFilesChanged === undefined ? {} : { onFilesChanged: props.onFilesChanged }),
    ...(props.client === undefined ? {} : { client: props.client }),
    ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
    ...(props.checkoutId === undefined ? {} : { checkoutId: props.checkoutId }),
    ...(props.directory === undefined ? {} : { directory: props.directory }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });

  const unavailable = bound && controller.status === "error";
  const onUnavailableChange = props.onUnavailableChange;
  useEffect(() => {
    onUnavailableChange?.(unavailable);
  }, [onUnavailableChange, unavailable]);

  if (!bound) {
    return (
      <p className="code-file-explorer__status" role="status">
        <FolderTree aria-hidden="true" size={16} />
        This Code thread is not bound to a checkout, so there are no repository files to list.
      </p>
    );
  }

  if (controller.status === "error") {
    // The one sentence, and one way back. Rendering the tree as well put a
    // live filter field and "No files match" beneath an explanation that
    // there are no files to match.
    // It is the pane's one state, so it is drawn as every pane's state is: a
    // mark, one line, the host's sentence in the muted ink and the way back.
    // A red notice with a button under it read as a toast over the pane's bar.
    return (
      <OctantEmpty
        action={{ label: "Try again", onClick: () => void controller.refresh() }}
        message={checkoutUnreadableReason(
          controller.errorMessage ?? "Repository files are unavailable.",
        )}
        role="alert"
        state="warning"
        title="This checkout can't be read"
      />
    );
  }

  return (
    <div className="code-file-explorer-panel">
      <CodeFileExplorer
        entries={controller.entries}
        loading={controller.status === "loading"}
        onOpenFile={props.onOpenFile}
        {...(props.onKeepFile === undefined ? {} : { onKeepFile: props.onKeepFile })}
        {...(props.changes === undefined ? {} : { changes: props.changes })}
        onRefresh={() => void controller.refresh()}
        refreshing={controller.status === "loading"}
        truncated={controller.truncated}
        {...(props.selectedPath === undefined ? {} : { selectedPath: props.selectedPath })}
      />
      {(props.extraFolders ?? []).map((folder, index) => (
        <ExtraFolderExplorer
          key={folder}
          folder={folder}
          live={index < MAX_LIVE_EXTRA_FOLDER_WATCHES}
          onOpenFile={props.onOpenFile}
          {...(props.onKeepFile === undefined ? {} : { onKeepFile: props.onKeepFile })}
          {...(props.threadId === undefined ? {} : { threadId: props.threadId })}
          {...(props.checkoutId === undefined ? {} : { checkoutId: props.checkoutId })}
          {...(props.client === undefined ? {} : { client: props.client })}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
        />
      ))}
    </div>
  );
}

/**
 * One extra folder of the Project, listed as its own tree. The host lists it
 * when asked for the folder by absolute path, and an entry opens by that
 * folder's path joined to the entry's, which is how the editor names a file
 * outside the checkout. A folder within the live limit is watched as the
 * checkout is, so its tree relists when something in it changes; any folder
 * relists on Refresh.
 */
function ExtraFolderExplorer(
  props: Pick<
    CodeFileExplorerPanelProps,
    | "threadId"
    | "checkoutId"
    | "client"
    | "serverUrl"
    | "windowCapability"
    | "onOpenFile"
    | "onKeepFile"
  > & { readonly folder: string; readonly live: boolean },
) {
  // A folder spelled in a way the file-path schema refuses (a decomposed
  // Unicode name, a backslash) is a valid folder on disk, so it is shown as
  // unavailable here rather than taking the whole explorer down.
  const directory = projectFilePath(props.folder);
  const controller = useCodeFileListingController({
    enabled: directory !== undefined,
    watch: props.live,
    watchFolder: props.folder,
    ...(directory === undefined ? {} : { directory }),
    ...(props.client === undefined ? {} : { client: props.client }),
    ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
    ...(props.checkoutId === undefined ? {} : { checkoutId: props.checkoutId }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const name = props.folder.slice(props.folder.lastIndexOf("/") + 1);
  return (
    <section aria-label={`${name} (extra folder)`} className="code-file-explorer-panel__folder">
      <h3 className="code-file-explorer-panel__folder-name">
        <FolderTree aria-hidden="true" size={14} />
        {name}
      </h3>
      {directory === undefined || controller.status === "error" ? (
        <OctantAlert className="code-file-explorer__error" tone="danger">
          {directory === undefined
            ? "Octant cannot list this folder because its name uses characters the editor does not accept."
            : (controller.errorMessage ?? "This folder's files are unavailable.")}
        </OctantAlert>
      ) : (
        <CodeFileExplorer
          entries={controller.entries}
          loading={controller.status === "loading"}
          onOpenFile={(entry) => {
            const path = projectFilePath(`${props.folder}/${entry.path}`);
            if (path !== undefined) props.onOpenFile({ ...entry, path });
          }}
          onKeepFile={(entry) => {
            const path = projectFilePath(`${props.folder}/${entry.path}`);
            if (path !== undefined) props.onKeepFile?.({ ...entry, path });
          }}
          onRefresh={() => void controller.refresh()}
          refreshing={controller.status === "loading"}
          truncated={controller.truncated}
          barControls={false}
        />
      )}
    </section>
  );
}

function projectFilePath(path: string) {
  try {
    return decodeCodeProjectFilePath(path);
  } catch {
    return undefined;
  }
}

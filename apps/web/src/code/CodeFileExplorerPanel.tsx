import {
  decodeCodeProjectFilePath,
  type CodeCheckoutId,
  type CodeFileChangeNotice,
  type CodeRelativePath,
  type CodeThreadId,
} from "@octant/contracts";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { FolderTree, RefreshCw } from "lucide-react";
import { CodeFileExplorer, type CodeFileExplorerEntry } from "./CodeFileExplorer";
import { useCodeFileListingController } from "./useCodeFileListingController";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface CodeFileExplorerPanelProps {
  readonly threadId?: CodeThreadId | undefined;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly directory?: CodeRelativePath | undefined;
  /** The Project's extra folders, by absolute path, each listed below the checkout. */
  readonly extraFolders?: ReadonlyArray<string> | undefined;
  readonly onOpenFile: (entry: Extract<CodeFileExplorerEntry, { readonly kind: "file" }>) => void;
  readonly selectedPath?: CodeRelativePath | undefined;
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly client?: CodeFileListingClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Called for every host-reported change, so an open editor can reload. */
  readonly onFilesChanged?: (notice: CodeFileChangeNotice) => void;
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

  if (!bound) {
    return (
      <p className="code-file-explorer__status" role="status">
        <FolderTree aria-hidden="true" size={16} strokeWidth={1.8} />
        This Code thread is not bound to a checkout, so there are no repository files to list.
      </p>
    );
  }

  if (controller.status === "error") {
    // The one sentence, and one way back. Rendering the tree as well put a
    // live filter field and "No files match" beneath an explanation that
    // there are no files to match.
    return (
      <div className="code-file-explorer-panel">
        <OctantAlert className="code-file-explorer__error" tone="danger">
          {controller.errorMessage ?? "Repository files are unavailable."}
        </OctantAlert>
        <div className="code-file-explorer-panel__recovery">
          <OctantButton
            onClick={() => void controller.refresh()}
            size="sm"
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Try again</span>
          </OctantButton>
        </div>
      </div>
    );
  }

  return (
    <div className="code-file-explorer-panel">
      <CodeFileExplorer
        entries={controller.entries}
        loading={controller.status === "loading"}
        onOpenFile={props.onOpenFile}
        onRefresh={() => void controller.refresh()}
        refreshing={controller.status === "loading"}
        truncated={controller.truncated}
        {...(props.selectedPath === undefined ? {} : { selectedPath: props.selectedPath })}
      />
      {(props.extraFolders ?? []).map((folder) => (
        <ExtraFolderExplorer
          key={folder}
          folder={folder}
          onOpenFile={props.onOpenFile}
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
 * outside the checkout. The host watches the folder as it does the checkout,
 * so the tree relists when something in it changes, and on Refresh.
 */
function ExtraFolderExplorer(
  props: Pick<
    CodeFileExplorerPanelProps,
    "threadId" | "checkoutId" | "client" | "serverUrl" | "windowCapability" | "onOpenFile"
  > & { readonly folder: string },
) {
  // A folder spelled in a way the file-path schema refuses (a decomposed
  // Unicode name, a backslash) is a valid folder on disk, so it is shown as
  // unavailable here rather than taking the whole explorer down.
  const directory = projectFilePath(props.folder);
  const controller = useCodeFileListingController({
    enabled: directory !== undefined,
    watch: true,
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
        <FolderTree aria-hidden="true" size={14} strokeWidth={1.8} />
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
          onRefresh={() => void controller.refresh()}
          refreshing={controller.status === "loading"}
          truncated={controller.truncated}
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

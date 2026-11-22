import {
  IMAGE_ARTIFACT_MEDIA_TYPES,
  MAX_GENERATED_IMAGE_BYTES,
  type BrowserThreadId,
} from "@octant/contracts";
import type { BrowserCaptureService } from "../browser/browserCaptureService";
import { prepareCanvasDesignAssetFile } from "../canvas/canvasDesignAssets";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import type { ImageSource, ThreadImageSources } from "./threadImageSources";

export function attachedImageSources<
  Attachment extends {
    readonly displayName: string;
    readonly mediaType: string;
    readonly byteLength: number;
  },
>(
  attachments: ReadonlyArray<Attachment>,
  read: (attachment: Attachment) => Promise<Uint8Array>,
): ReadonlyArray<ImageSource> {
  return attachments.flatMap((attachment) =>
    IMAGE_ARTIFACT_MEDIA_TYPES.some((type) => type === attachment.mediaType)
      ? [
          {
            label: `your attached photo ${attachment.displayName}`,
            name: attachment.displayName,
            size: attachment.byteLength,
            read: () => read(attachment),
          },
        ]
      : [],
  );
}

export function workspaceImageSources(input: {
  readonly threadId: BrowserThreadId;
  readonly browserCaptures: Pick<BrowserCaptureService, "list" | "read">;
  readonly root: () => Promise<string | undefined>;
}): Pick<ThreadImageSources, "browserCapture" | "file"> {
  return {
    browserCapture: (id) => {
      const capture = input.browserCaptures
        .list(input.threadId)
        .find((item) => item.captureId === id);
      if (capture === undefined || capture.recording !== undefined) return undefined;
      let label = "Browser screenshot";
      try {
        const host = new URL(capture.url).hostname;
        if (host !== "") label += ` of ${host}`;
      } catch {
        // Capture labels never expose a URL path, query, or credential.
      }
      return {
        label,
        size: capture.size,
        ...(capture.profile === undefined ? {} : { signedIn: true }),
        read: async () => (await input.browserCaptures.read(input.threadId, id))?.bytes,
      };
    },
    file: async (path) => {
      const root = await input.root();
      if (root === undefined) return undefined;
      const prepared = await prepareCanvasDesignAssetFile({
        filesystem: liveWorkFilesystem,
        root,
        path,
        maximumBytes: MAX_GENERATED_IMAGE_BYTES,
      });
      return prepared.status === "unavailable"
        ? undefined
        : {
            label: path,
            size: prepared.size,
            read: async () => ((await input.root()) === root ? prepared.read() : undefined),
          };
    },
  };
}

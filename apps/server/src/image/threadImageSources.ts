import {
  decodeBrowserCaptureId,
  decodeImageArtifactId,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_REFERENCE_LABEL_LENGTH,
  MAX_IMAGE_REFERENCES,
  type ImageOfferReference,
} from "@octant/contracts";
import { canonicalizeWorkRelativePath, WorkConfinementRejected } from "@octant/domain";
import { sniffGeneratedImageMediaType } from "./generatedImageStore";
import type { EnqueueImageJobInput } from "./imageJobService";

export type ImageSourceRequest =
  | { readonly kind: "attachment" }
  | {
      readonly kind: "browser-capture";
      readonly captureId: ReturnType<typeof decodeBrowserCaptureId>;
    }
  | { readonly kind: "file"; readonly relativePath: string }
  | {
      readonly kind: "generated-image";
      readonly attachmentId: ReturnType<typeof decodeImageArtifactId>;
    };

export interface ImageSource {
  readonly label: string;
  readonly size: number;
  readonly signedIn?: true;
  readonly read: () => Promise<Uint8Array | undefined>;
}

export interface ThreadImageSources {
  readonly latestAttachments: () => ReadonlyArray<ImageSource>;
  readonly browserCapture?: (
    id: ReturnType<typeof decodeBrowserCaptureId>,
  ) => ImageSource | undefined;
  readonly file?: (path: string) => Promise<ImageSource | undefined>;
}

type Refused = { readonly error: string };
type DescribedSource = { readonly reference: ImageOfferReference; readonly source: ImageSource };

export function parseImageSourceRequests(
  value: unknown,
): ReadonlyArray<ImageSourceRequest> | Refused {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_REFERENCES) {
    return { error: "Use at most four image references." };
  }
  const requests: ImageSourceRequest[] = [];
  for (const item of value as ReadonlyArray<unknown>) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: "An image reference is invalid." };
    }
    const entry = item as Readonly<Record<string, unknown>>;
    const { kind, ...fields } = entry;
    try {
      if (kind === "attachment" && Object.keys(fields).length === 0) {
        requests.push({ kind });
      } else if (kind === "browser-capture" && Object.keys(fields).length === 1) {
        requests.push({ kind, captureId: decodeBrowserCaptureId(fields.captureId) });
      } else if (kind === "generated-image" && Object.keys(fields).length === 1) {
        requests.push({ kind, attachmentId: decodeImageArtifactId(fields.attachmentId) });
      } else if (
        kind === "file" &&
        Object.keys(fields).length === 1 &&
        typeof fields.relativePath === "string" &&
        fields.relativePath.trim().length > 0 &&
        fields.relativePath.length <= MAX_IMAGE_REFERENCE_LABEL_LENGTH
      ) {
        requests.push({ kind, relativePath: canonicalizeWorkRelativePath(fields.relativePath) });
      } else {
        return { error: "An image reference is invalid." };
      }
    } catch (error) {
      return {
        error:
          error instanceof WorkConfinementRejected
            ? "The image reference must be inside this thread's folder."
            : "An image reference is invalid.",
      };
    }
  }
  return requests;
}

export async function describeImageSources(
  requests: ReadonlyArray<ImageSourceRequest>,
  ports: ThreadImageSources | undefined,
  generated: (id: string) => ImageSource | undefined,
): Promise<ReadonlyArray<DescribedSource> | Refused> {
  const results: DescribedSource[] = [];
  let total = 0;
  for (const request of requests) {
    const source =
      request.kind === "file"
        ? await ports?.file?.(request.relativePath)
        : request.kind === "browser-capture"
          ? ports?.browserCapture?.(request.captureId)
          : request.kind === "generated-image"
            ? generated(String(request.attachmentId))
            : undefined;
    const sources =
      request.kind === "attachment"
        ? (ports?.latestAttachments() ?? [])
        : source === undefined
          ? []
          : [source];
    if (sources.length === 0) {
      return {
        error:
          request.kind === "attachment"
            ? "The latest message on this thread has no attached images."
            : "An image reference is unavailable on this thread.",
      };
    }
    for (const image of sources) {
      if (results.length === MAX_IMAGE_REFERENCES) {
        return { error: "Use at most four image references, including any parent image." };
      }
      total += image.size;
      if (
        image.size <= 0 ||
        image.size > MAX_GENERATED_IMAGE_BYTES ||
        total > MAX_GENERATED_IMAGE_BYTES * 2
      ) {
        return { error: "Reference images exceed the size limit or are empty." };
      }
      results.push({
        source: image,
        reference: {
          kind: request.kind,
          label: image.label.trim().slice(0, MAX_IMAGE_REFERENCE_LABEL_LENGTH).trimEnd(),
          ...(image.signedIn === true ? { signedIn: true } : {}),
        },
      });
    }
  }
  return results;
}

export async function readImageSources(
  sources: ReadonlyArray<DescribedSource>,
  signal?: AbortSignal,
): Promise<NonNullable<EnqueueImageJobInput["references"]> | Refused> {
  const images = [];
  for (const { source } of sources) {
    if (signal?.aborted === true) return { error: "Image generation was cancelled." };
    const bytes = await source.read().catch(() => undefined);
    if (bytes === undefined || bytes.byteLength !== source.size) {
      return { error: "A reference image is no longer available or changed while waiting." };
    }
    const mediaType = sniffGeneratedImageMediaType(bytes);
    if (mediaType === undefined)
      return { error: "A reference is not a PNG, JPEG, WebP or GIF image." };
    images.push({ bytes, mediaType });
  }
  return images;
}

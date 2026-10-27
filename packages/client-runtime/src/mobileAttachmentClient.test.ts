import { describe, expect, it } from "vitest";
import {
  MOBILE_ATTACHMENT_MAX_BYTES,
  mobileAttachmentOffer,
  uploadMobileChatAttachment,
  uploadMobileCodeAttachment,
  uploadMobileWorkAttachment,
} from "./mobileAttachmentClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import type { MobileModelOption } from "./mobileProviderClient";

const threadId = "00000000-0000-4000-8000-000000000201";
const attachmentId = "00000000-0000-4000-8000-000000000301";
const digest = "a".repeat(64);

function option(
  attachmentModalities: MobileModelOption["attachmentModalities"],
): MobileModelOption {
  return {
    id: "p1::m1",
    providerInstanceId: "p1",
    modelId: "m1",
    label: "Model",
    detail: "Provider",
    attachmentModalities,
  };
}

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

function recordingTransport(answer: (request: Recorded) => Response): {
  readonly transport: MobileRemoteTransport;
  readonly requests: Recorded[];
} {
  const requests: Recorded[] = [];
  return {
    requests,
    transport: {
      hostId: "host-1",
      authenticatedFetch: async (request) => {
        requests.push(request);
        return answer(request);
      },
    },
  };
}

describe("what a phone may attach to a thread", () => {
  it("offers a Chat thread the camera, the library, and files of the kinds its model takes", () => {
    expect(mobileAttachmentOffer("chat", option(["image", "document"]))).toEqual({
      sources: ["camera", "library", "file"],
      mediaTypes: [
        "text/plain",
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
      ],
    });
    expect(mobileAttachmentOffer("chat", option(["document"]))).toEqual({
      sources: ["file"],
      mediaTypes: ["text/plain", "application/pdf"],
    });
  });

  it("offers Work and Code threads images only, and only when the thread's model takes them", () => {
    const images = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    for (const mode of ["work", "code"] as const) {
      expect(mobileAttachmentOffer(mode, option(["image", "document"]))).toEqual({
        sources: ["camera", "library", "file"],
        mediaTypes: images,
      });
      expect(mobileAttachmentOffer(mode, option(["document"]))).toEqual({
        sources: [],
        mediaTypes: [],
      });
    }
  });

  it("offers nothing when the host does not list the thread's model as ready", () => {
    expect(mobileAttachmentOffer("chat", undefined)).toEqual({ sources: [], mediaTypes: [] });
    expect(mobileAttachmentOffer("chat", option([]))).toEqual({ sources: [], mediaTypes: [] });
  });
});

describe("uploading a phone attachment to the thread's own route", () => {
  const photo = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

  it("stages a Work photo under the Work thread's identity", async () => {
    const { transport, requests } = recordingTransport(() =>
      Response.json({
        attachmentId,
        displayName: "photo.jpg",
        mediaType: "image/jpeg",
        byteLength: 4,
        digest,
      }),
    );

    const reference = await uploadMobileWorkAttachment({
      transport,
      threadId,
      attachmentId,
      displayName: "photo.jpg",
      mediaType: "image/jpeg",
      bytes: photo,
    });

    expect(reference).toMatchObject({ attachmentId, byteLength: 4 });
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/api/work/attachments",
        contentType: "image/jpeg",
        headers: {
          "x-octant-work-thread-id": threadId,
          "x-octant-work-attachment-id": attachmentId,
          "x-octant-work-display-name": "photo.jpg",
        },
        body: photo,
      },
    ]);
  });

  it("stages a Code photo under the Code thread's identity", async () => {
    const { transport, requests } = recordingTransport(() =>
      Response.json({
        attachmentId,
        displayName: "whiteboard 1.png",
        mediaType: "image/png",
        byteLength: 4,
        digest,
      }),
    );

    await uploadMobileCodeAttachment({
      transport,
      threadId,
      attachmentId,
      displayName: "whiteboard 1.png",
      mediaType: "image/png",
      bytes: photo,
    });

    expect(requests[0]).toMatchObject({
      method: "PUT",
      path: "/api/code/attachments",
      contentType: "image/png",
      headers: {
        "x-octant-code-thread-id": threadId,
        "x-octant-code-attachment-id": attachmentId,
        "x-octant-code-display-name": "whiteboard%201.png",
      },
    });
  });

  it("refuses a file the mode does not take or larger than a paired upload, without sending it", async () => {
    const { transport, requests } = recordingTransport(() => Response.json({}));
    const tooLarge = new Uint8Array(MOBILE_ATTACHMENT_MAX_BYTES + 1);

    await expect(
      uploadMobileWorkAttachment({
        transport,
        threadId,
        attachmentId,
        displayName: "notes.pdf",
        mediaType: "application/pdf",
        bytes: photo,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    await expect(
      uploadMobileCodeAttachment({
        transport,
        threadId,
        attachmentId,
        displayName: "big.jpg",
        mediaType: "image/jpeg",
        bytes: tooLarge,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    await expect(
      uploadMobileChatAttachment({
        transport,
        threadId,
        attachmentId,
        displayName: "big.jpg",
        mediaType: "image/jpeg",
        bytes: tooLarge,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(requests).toEqual([]);
  });

  it("says the host refused an image it could not read", async () => {
    const { transport } = recordingTransport(() => new Response("{}", { status: 415 }));

    await expect(
      uploadMobileWorkAttachment({
        transport,
        threadId,
        attachmentId,
        displayName: "photo.jpg",
        mediaType: "image/jpeg",
        bytes: photo,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
  });
});

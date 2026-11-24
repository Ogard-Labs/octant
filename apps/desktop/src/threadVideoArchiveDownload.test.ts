import { describe, expect, it, vi } from "vitest";
import { startThreadVideoArchiveDownload } from "./threadVideoArchiveDownload";

describe("desktop thread archive downloads", () => {
  const ticket = "A".repeat(43);

  it("downloads only the fixed archive path on the window's local host", () => {
    const downloadURL = vi.fn();
    expect(startThreadVideoArchiveDownload({ downloadURL }, "http://127.0.0.1:3100", ticket)).toBe(
      true,
    );
    expect(downloadURL).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:3100/api/threads/export/video-archive?ticket=${ticket}`,
    );
  });

  it("refuses arbitrary renderer URLs and hosts outside loopback", () => {
    const downloadURL = vi.fn();
    expect(
      startThreadVideoArchiveDownload(
        { downloadURL },
        "http://127.0.0.1:3100",
        "http://elsewhere.test/",
      ),
    ).toBe(false);
    expect(startThreadVideoArchiveDownload({ downloadURL }, "https://elsewhere.test", ticket)).toBe(
      false,
    );
    expect(downloadURL).not.toHaveBeenCalled();
  });
});

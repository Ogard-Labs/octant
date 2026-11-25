import type { AccessActivityEntry, ChangeNotice } from "@octant/contracts/access-activity";
import { describe, expect, it } from "vitest";
import {
  accessActorPhrase,
  changeNoticeActions,
  describeAccessEntry,
  describeChangeNotice,
  relativeTimeLabel,
} from "./accessActivityPresentation";

const id = "00000000-0000-4000-8000-0000000000a1";
const device = { kind: "device", deviceId: id, label: "Ada's laptop" } as const;
const agent = { kind: "agent", grantId: id, name: "Release bot" } as const;

describe("access activity on the phone", () => {
  it("says what happened to each device and who did it", () => {
    const base = { entryId: id, at: "2026-11-25T10:00:00.000Z", deviceId: id };
    const entries: ReadonlyArray<AccessActivityEntry> = [
      { ...base, kind: "added", deviceLabel: "Tablet", accessLevel: "full", actor: device },
      {
        ...base,
        kind: "relevelled",
        deviceLabel: "Tablet",
        previousLevel: "full",
        accessLevel: "read-only",
        actor: { kind: "local-person" },
      },
      {
        ...base,
        kind: "removed",
        deviceLabel: "Tablet",
        reason: "expired",
        actor: { kind: "host" },
      },
    ];
    expect(entries.map(describeAccessEntry)).toEqual([
      "Tablet added at Full",
      "Tablet changed from Full to Read only",
      "Tablet pairing expired",
    ]);
    expect(
      [device, agent, { kind: "local-person" }, { kind: "host" }, { kind: "owner-device" }].map(
        (actor) => accessActorPhrase(actor as never),
      ),
    ).toEqual([
      "By Ada's laptop",
      "By the agent Release bot",
      "By you on this computer",
      "By this computer",
      "By an owner device",
    ]);
  });

  it("names who raised what, with Undo only where the earlier state is kept", () => {
    const raised: ChangeNotice = {
      kind: "thread-level-raised",
      noticeId: id,
      at: "2026-11-25T10:00:00.000Z",
      actor: device,
      surface: "code",
      threadId: "thread-1",
      threadTitle: "Fix login",
      from: "ask-first",
      to: "full-access",
    };
    const replaced: ChangeNotice = {
      kind: "provider-key-replaced",
      noticeId: id,
      at: "2026-11-25T10:00:00.000Z",
      actor: agent,
      providerInstanceId: id,
      providerName: "Anthropic",
    };
    expect(describeChangeNotice(raised)).toBe(
      "Ada's laptop raised “Fix login” from Ask first to Full access",
    );
    expect(describeChangeNotice(replaced)).toBe(
      "The agent Release bot replaced the key for Anthropic",
    );
    expect(changeNoticeActions(raised)).toMatchObject({
      undo: true,
      revokeLabel: "Revoke Ada's laptop",
      revokeConfirmLabel: "Revoke device",
    });
    expect(changeNoticeActions(replaced)).toMatchObject({
      undo: false,
      noUndoReason: "No Undo: the earlier key is not kept.",
      revokeLabel: "End Release bot's access",
      revokeConfirmLabel: "End access",
    });
  });

  it("reads how long ago a change was made", () => {
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    expect(relativeTimeLabel("2026-11-25T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTimeLabel("2026-11-25T11:15:00.000Z", now)).toBe("45 min ago");
    expect(relativeTimeLabel("2026-11-25T07:00:00.000Z", now)).toBe("5 h ago");
    expect(relativeTimeLabel("2026-11-22T12:00:00.000Z", now)).toBe("3 d ago");
    expect(relativeTimeLabel("not a time", now)).toBe("not a time");
  });
});

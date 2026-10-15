import { describe, expect, it } from "vitest";
import {
  chatThreadStandsInProject,
  isDeviceRegistrationCurrent,
} from "./pairedDeviceApprovalAuthority";

const now = Date.parse("2026-10-15T12:00:00.000Z");

describe("paired device approval authority", () => {
  it("stops counting a device as paired once its deadline passes, before the expiry is reconciled", () => {
    expect(
      isDeviceRegistrationCurrent({ state: "active", expiresAt: "2026-10-16T00:00:00.000Z" }, now),
    ).toBe(true);
    expect(
      isDeviceRegistrationCurrent({ state: "active", expiresAt: "2026-10-15T12:00:00.000Z" }, now),
    ).toBe(false);
    expect(isDeviceRegistrationCurrent({ state: "active", expiresAt: "not a date" }, now)).toBe(
      false,
    );
    expect(
      isDeviceRegistrationCurrent({ state: "revoked", expiresAt: "2026-10-16T00:00:00.000Z" }, now),
    ).toBe(false);
    expect(isDeviceRegistrationCurrent(undefined, now)).toBe(false);
  });

  it("refuses a Chat thread that was archived, moved to another Project, or is gone", () => {
    const projectId = "77000000-0000-4000-8000-000000000001";
    expect(chatThreadStandsInProject({ lifecycle: "active", projectId }, projectId)).toBe(true);
    expect(chatThreadStandsInProject({ lifecycle: "active" }, undefined)).toBe(true);
    expect(chatThreadStandsInProject({ lifecycle: "archived", projectId }, projectId)).toBe(false);
    expect(
      chatThreadStandsInProject(
        { lifecycle: "active", projectId: "77000000-0000-4000-8000-000000000002" },
        projectId,
      ),
    ).toBe(false);
    expect(chatThreadStandsInProject({ lifecycle: "active", projectId }, undefined)).toBe(false);
    expect(chatThreadStandsInProject({ lifecycle: "active" }, projectId)).toBe(false);
    expect(chatThreadStandsInProject(undefined, undefined)).toBe(false);
  });
});

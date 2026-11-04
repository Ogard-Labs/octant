import { describe, expect, it } from "vitest";
import { googleWorkspaceServiceForResource } from "./googleWorkspaceConnectors";

describe("Google Workspace service permissions", () => {
  it("requests only mail reading for Gmail even when the server advertises sending and full mailbox access", () => {
    const service = googleWorkspaceServiceForResource("https://gmailmcp.googleapis.com/mcp/v1");
    expect(service?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });

  it("keeps Drive file reading and Calendar event reading in separate consent requests", () => {
    expect(googleWorkspaceServiceForResource("https://drivemcp.googleapis.com/mcp/v1")?.scopes).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
    expect(googleWorkspaceServiceForResource("https://calendarmcp.googleapis.com/mcp/v1")?.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ]);
  });

  it("does not assign Google credentials or permissions to another resource", () => {
    for (const resource of [
      "https://gmailmcp.googleapis.com.attacker.example/mcp/v1",
      "https://gmailmcp.googleapis.com/mcp/v2",
      "https://gmailmcp.googleapis.com/mcp/v1?scope=send",
      "http://gmailmcp.googleapis.com/mcp/v1",
      "https://mcp.example/mcp",
    ]) {
      expect(googleWorkspaceServiceForResource(resource)).toBeUndefined();
    }
  });
});

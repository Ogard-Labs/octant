export interface GoogleWorkspaceService {
  readonly id: "google-gmail" | "google-drive" | "google-calendar";
  readonly displayName: string;
  readonly resource: string;
  readonly description: string;
  readonly scopes: ReadonlyArray<string>;
  readonly api: string;
  readonly mcpApi: string;
}

/**
 * Read workflows documented by Google's Workspace MCP reference. The resource
 * metadata advertises every possible scope, including writes and mail sending;
 * it is discovery data, not the person's permission selection.
 */
export const GOOGLE_WORKSPACE_SERVICES: ReadonlyArray<GoogleWorkspaceService> = [
  {
    id: "google-gmail",
    displayName: "Gmail",
    resource: "https://gmailmcp.googleapis.com/mcp/v1",
    description: "Search and read mail. Cannot draft, send, label, or delete messages.",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    api: "gmail.googleapis.com",
    mcpApi: "gmailmcp.googleapis.com",
  },
  {
    id: "google-drive",
    displayName: "Google Drive",
    resource: "https://drivemcp.googleapis.com/mcp/v1",
    description: "Search and read files. Cannot create, change, share, or delete files.",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    api: "drive.googleapis.com",
    mcpApi: "drivemcp.googleapis.com",
  },
  {
    id: "google-calendar",
    displayName: "Google Calendar",
    resource: "https://calendarmcp.googleapis.com/mcp/v1",
    description:
      "List calendars and read events. Cannot create, change, or delete events or send replies.",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
    api: "calendar-json.googleapis.com",
    mcpApi: "calendarmcp.googleapis.com",
  },
];

export function googleWorkspaceServiceForResource(
  resource: string,
): GoogleWorkspaceService | undefined {
  return GOOGLE_WORKSPACE_SERVICES.find((service) => service.resource === resource);
}

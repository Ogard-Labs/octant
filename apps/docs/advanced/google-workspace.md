# Google Workspace preview

Gmail, Google Drive, and Google Calendar use Google's own remote MCP servers.
The first supported workflows are read-only. Connecting one service does not
connect the others, and account consent never expands a task's authority.

These services are in Google's Developer Preview, not general availability.
They require an enrolled Google Workspace account and a registered Google Cloud
project. A client ID alone does not establish eligibility. Google's preview
terms restrict public applications and access outside your domain or company
before general availability. Public distribution remains held until Google
permits it or announces general availability. See the
[preview program and terms](https://developers.google.com/workspace/preview).

## Prepare your project

In your enrolled project, enable the API and MCP service for the product you
intend to connect. No Octant action creates a project, enables an API, changes
an administrator's policy, or submits an application for review.

| Service | API | MCP service | Read permission |
| --- | --- | --- | --- |
| Gmail | `gmail.googleapis.com` | `gmailmcp.googleapis.com` | `https://www.googleapis.com/auth/gmail.readonly` |
| Google Drive | `drive.googleapis.com` | `drivemcp.googleapis.com` | `https://www.googleapis.com/auth/drive.readonly` |
| Google Calendar | `calendar-json.googleapis.com` | `calendarmcp.googleapis.com` | `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.readonly` |

Create an OAuth client with application type **Desktop app** and select
**Use this client for an AI-powered agent** when creating it. Copy its client
ID. Octant uses a public native client, a browser sign-in, PKCE S256, and a
loopback reply address on this computer. It does not need a client secret or
another application's hosted callback. See Google's
[Desktop client instructions](https://developers.google.com/workspace/guides/create-credentials#desktop-app)
and [native OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app#loopback-ip-address).

Configure the consent screen for your intended audience. External apps in
Testing must list the intended test users. Google Workspace administrators can
deny an application or individual scopes. Gmail and Drive reading use
restricted scopes; public applications may require OAuth verification, and
restricted data sent to servers may require a security assessment. The use of
a third-party model provider is relevant to that review. See
[Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [Drive scope requirements](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Consent and allowed work

Each connection asks only for its own read permissions. Google's resource
metadata lists additional scopes, including writes, but that list does not
select Octant's consent scope.

- Gmail can search and read messages and threads. It cannot create drafts,
  send mail, change labels, or delete messages. In particular, Gmail's
  `gmail.compose` permission also permits sending mail and is not requested.
- Drive can search and read eligible files. It cannot create, edit, share, or
  delete files. Google can exclude files because of access rights, download
  restrictions, encryption, organizational policies, spam, or trash state.
- Calendar can list calendars and read events. It cannot create, edit, or
  delete events, respond to invitations, or send meeting replies.

Select the intended Google account in the browser. Declining consent or an
administrator's denial leaves the task and its draft intact. A connection is
usable only where the task, Project, provider, mode, and component activation
already permit the tools. A listed tool is not permission to run it.

## Persistence and recovery

Octant asks for offline access with Google's `access_type=offline` parameter;
the OIDC `offline_access` scope is not a substitute. Access and refresh tokens
remain in the existing host credential broker, not in the journal, exported
task, package, or model context. A supported refresh grant renews an expired
access token without hourly sign-in.

New consent is needed when a refresh token is missing or no longer valid.
Ordinary reuse does not request consent again. Google's External Testing
projects normally issue refresh tokens that expire after seven days. A
password change involving Gmail, revocation, administrator policy, and token
limits can also end a grant. See
[Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

If sign-in fails, check enrollment, API enablement, the agentic-client setting,
test-user membership, and administrator restrictions. If the local callback
port is busy, close the conflicting listener or choose another port in setup.
Return to the existing task after connecting. A provider that cannot update
its active tool set needs an explicit continuation or restart that retains
the draft.

## Verify a connection

Use test data with your enrolled account. Read a known message through Gmail,
find and read an eligible Drive file, and list a known Calendar event. Attempt
a write in each service and confirm refusal without broader consent. Restart
Octant and repeat an allowed read. Exercise expired access-token refresh,
revocation, account switching, partial consent, and administrator denial.

Endpoint discovery, token exchange, and a tool list are setup evidence. They
do not prove that one of these workflows succeeded. Google's
[Workspace MCP setup guide](https://developers.google.com/workspace/guides/configure-mcp-servers)
documents the endpoints and representative tool workflows. Requirements on
this page were checked against Google's primary documentation on 3 November
2026; no live account authorization is implied by that documentation check.

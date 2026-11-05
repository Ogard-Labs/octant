---
description: How to link a password manager you already use, point a provider's API key at an item in it, and what Octant keeps, fetches, and records.
---

# Use API keys from a secret store

If you keep your API keys in a password manager, Octant can read a key from
there instead of storing a copy. You link the manager once, then point a
provider at an item in it. Octant keeps the item's address and asks the manager
for the key each time the key is used.

The 1Password command line tool (`op`) is supported today. Other tools can be
added without changing how this works.

The provider-key path below keeps values out of the agent. The separately
approved Full access command channel later in this guide gives credentials
directly to its recipient and has different disclosure limits.

## What Octant keeps, and what it does not

| Octant keeps                                                     | Octant never keeps                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| That you linked the store, and when                              | The key itself                                         |
| The item's address, for example `op://Private/OpenAI/credential` | A copy of the key on disk, in a log, or in the history |
| A line in the history when you link, unlink, or change an item   | Anything the manager printed while it answered         |

The key is fetched when a request needs it, handed to the provider, and
dropped. It is never shown in Octant and never given to an agent. A rotated
key is used by the next request, because nothing was cached.

## Link a store

1. Install the 1Password command line tool and sign in to 1Password, so the
   store is unlocked.
2. Open **Settings › Secret stores**.
3. Choose **Link 1Password**.

If 1Password is locked, or the tool is not installed, Octant says so and does
not link anything. Unlock 1Password, or install the tool, and try again.

**Check an item** tells you whether Octant can read an item, without showing
what is in it. Type the item's address and choose **Check**. The answer is
_Found_, _The store is locked_, or _No item with that reference was found_.

## Point a provider's key at an item

1. Open **Settings › Providers & Models** and open the provider.
2. Under **Key from a secret store**, enter the item's address and choose
   **Use this item**.

Octant checks the item first. If the store is locked or the item is not there,
it tells you and changes nothing. Once it works, the provider's credential reads
as stored, and requests use the key from the manager.

- **Check** reads the item again and says whether it was found.
- **Change item** points the provider at a different item.
- **Remove** removes the address. It does not touch the item in your manager.

A provider that already holds a key you stored in Octant is not changed. Remove
that key first, then point the provider at an item. A provider that holds an
item cannot also take a pasted key: remove the item first.

## Use an item for an MCP server's secret

When you add an MCP server by hand (**Settings › Skills & Extensions › Add MCP
server…**), mark a variable or header **Secret**. If a store is linked, the row
also offers **From 1Password**: enter the item's address instead of the value.
Octant checks the item before it adds the server, keeps only the address in the
host's credential store, and fetches the value each time the server starts.
Removing the server removes the address, not the item.

## Let the AWS command line sign in

Octant keeps agents away from `~/.aws/credentials`. To let the AWS command
line work in Octant's own shell anyway, keep your access key pair in your
password manager and point Octant at it:

1. Open **Settings › Secret stores › AWS command line**.
2. Enter the address of the item that holds the access key ID, and of the item
   that holds the secret access key.
3. Choose **Use these items**.

Octant checks both items first. From then on, each command in Octant's own
shell gets a session that lasts one hour, made by AWS from your key pair. The
command never sees the key pair itself, and Octant never keeps it. A session's
secret is removed from any output Octant keeps.

If the store is locked or an item is gone, the command runs without AWS
credentials and the AWS command line says it found none. **Remove** stops
handing out sessions. Claude Code, Codex, and other providers' own commands
do not get a session. Azure command-line credentials are not supported yet.

## Let gcloud use a service account

For `gcloud` commands in Octant's own shell:

1. Keep the service-account JSON in an item in your linked 1Password store.
2. Open **Settings › Secret stores › Google Cloud command line** and enter
   its item address, exact service-account email, and the Google OAuth scope
   URLs these commands need.
3. Choose **Review Google Cloud account**, check the account and scopes, then
   choose **Use this service account**. Cancel leaves the account unchanged.

The broker reads the signing key; the command receives only an expiring token
in its own temporary file and private configuration. Tokens last at most one
hour and are not refreshed during a command. The account's IAM roles can
allow access to several cloud Projects: choosing a task's Project does not
narrow those roles. This channel does not supply ADC, `gsutil`, `bq`, delegated
users, impersonation, provider-native commands, or worktree setup.

**Read current Google account** reports the saved reference and last known
token expiry without issuing a token. If a change is not confirmed, read the
current account before retrying. **Remove Google Cloud account** and unlink
stop pending and future use; tokens already received by running commands may
remain valid until expiry. They do not sign out the host or revoke the cloud
account. When a configured channel is unavailable, Octant supplies an empty
token file and isolated configuration with a recovery message, rather than
using the host's saved sign-in. If command recovery is unavailable, repair it
and restart the host; ordinary token-free commands remain available.

## When the store is locked or the item is gone

Requests fail the way a missing key does, with a message that names the cause:
the store is locked, the store could not be reached, or the item was not found.
Octant does not fall back to another copy of the key. Unlock the store, or fix
the address, and send the request again.

## Unlink a store

Choose **Unlink** next to the store in **Settings › Secret stores**. Providers
whose key points at an item in that store stop getting their key until you link
it again. Their addresses stay, so linking again brings them back. Nothing in
your manager is changed or deleted.

## Where this works

Linking a store and pointing a key at it happen in a local Octant window on the
host computer. A paired phone or browser cannot link a store or change an item.
A host with no credential store, such as a Linux machine without a keyring,
shows that **Secret stores** is unavailable.

## Record permission for a Browser login item

In a task's native Browser, choose **Login permission**. Take over the page or
wait for the agent's sign-in handoff before reviewing a new item.

1. Enter the exact 26-character account, vault and item IDs from 1Password.
   Names are not accepted, so a similarly named account or item cannot be
   selected silently. Never paste a password or one-time code.
2. Choose **Review item**. Octant checks only that selected item's metadata
   through its credential broker. The review shows the item, account, vault,
   exact HTTPS site and port, top frame and Browser profile.
3. Choose this Project's eligible threads or the stricter task/page scope,
   then **Allow selected item**. Private pages permit task/page scope only.
4. Use **Revoke permission** to remove a recorded permission.

Saving permission fills nothing. To use it, choose **Review login form**,
check the field labels and exact submission/return sites, then **Fill selected
fields**. Check the page before separately choosing **Submit sign-in form**.
No website sign-in result is claimed. Iframes are not included. The item
must list both the current page and the form destination as verified saved HTTPS
websites, including each exact port. If either is missing, sign in manually or
correct the item’s saved websites yourself, then review again. Octant never
changes them automatically;
missing, malformed or more than eight saved websites refuse the review.

Permission ends when the host restarts or after eight hours. Cookies and
1Password unlock do not renew it. Item/link changes are detected on the next
permission read; clearing the profile also invalidates its permissions.
A saved snapshot must be checked again before use. No password, OTP or raw
item JSON is returned to the agent, Octant UI or journal. The CLI's selected
item JSON may contain concealed fields inside the adapter; Octant projects
only the named metadata fields and discards raw output.

Only one clear username/current-password form with an HTTPS POST action in the
same top frame can be filled. An unsupported or changed form stays manual.
Complete MFA, CAPTCHA or passkeys yourself. A filled form is not a signed-in
account. Explicitly approved SSO outbound and return sites keep the same
Browser task/profile; other destinations and iframe access are not granted.

The agent cannot act on or observe the page during the private credential read,
fill or submission. Overlapping reads are also withheld. Cancelling before
native commit prevents the effect; after commit starts, Octant reports that
it may have run and cannot undo it. Check the page before continuing.
The website receives the credential and its own scripts can retain or reflect
it. The hold and credential-free broker results do not prove that a later page
snapshot is safe or that a reload removed callbacks. Hand the page back only
when you are ready to share what it shows.

## One-time token requests in Code

An agent can use `request_credential` to open a private card in its Code
conversation. Currently this supports a one-time Linear account access check.
Enter the API token and choose **Check access**, or choose **Decline**. The token
is sent only to Linear for the displayed check; it does not become a chat
message or a saved sign-in. The destination and one-use scope are shown above
the field. Use **Show token** to check your entry, or expand **Not saved or added
to chat** for handling details.

The request expires after ten minutes and ends when the turn is cancelled or
loses access. If the connection fails, Octant clears your entry and does not
retry automatically. A token already sent to Linear cannot be recalled.

This card is available at the originating local window, outside Plan mode, for
providers that support app-managed tools. It does not accept administrator
passwords or hand credentials to arbitrary shell commands. Choosing a linked
1Password item is not yet available in this card; existing Settings bindings
continue to work separately.

## Run a named command with linked credentials

For a normal Code task at **Full access**, you can save a command binding in
**Settings › Secret stores › Credential commands**. Choose its Code Project,
absolute recipient executable, fixed arguments (one per line), directory within
the Project and explicit 1Password account ID. Add one to eight environment
mappings as `ENV=op://vaultID/itemID/[sectionID/]fieldID`. Use immutable IDs,
not names or secret values. Reserved runtime and authority variables refuse.
The local op 2 CLI and recipient are pinned by path and digest when saved;
replacing either requires saving a new binding.
After `op` finishes any unlock or authentication wait, a fixed Octant bootstrap
checks the recipient's path, digest and file identity again before starting it.
A changed recipient refuses. A brief final check-to-exec race remains; this is
not an atomic guarantee against concurrent executable replacement. The bootstrap
uses Octant's own trusted runtime and refuses if its required execution support
is unavailable. Runtime flags do not become credential mappings or reach the
recipient.

Open **Credential commands** in the Code conversation and choose **Review**.
An agent can request the same review with `octant_command`; it cannot approve
it. Check the executable, arguments, directory, account, reference mappings and
timeout, then choose **Approve one run**, **Deny**, or **Cancel command**.
Approval expires after three minutes if the child has not started. A started
command keeps its displayed timeout, up to five minutes.

The recipient and its descendants receive the credentials and ordinary Full
access, including network access. Choose a recipient you trust. `op run`
conceals secrets in ordinary output by default, but a recipient can encode,
write or send them elsewhere. Octant cannot promise complete redaction of
values it never receives. The broker returns only reference authorization;
it does not return resolved command credentials to the server or renderer.

Window revocation, unlinking, changing a binding or losing current Code
authority invalidates pending use observed by this host. The final launch also
rechecks the broker revision and owning checkout/root authority. These reads
are not an atomic revocation transaction across processes. Cancellation before
spawn prevents that command; after spawn it requests termination and reports
possible effects. It cannot undo a request or revoke a credential already used.
A zero exit code does not prove the intended account operation succeeded.

Settings bindings survive restart; approvals and output do not. A repeated
preparation replays only while its request/receipt is retained. After restart
or eviction, review and approve a new request. That does not mean an earlier
process stopped. The journal retains its start/outcome metadata for recovery.
A missing, replaced or unsupported CLI refuses; a locked store or invalid item
may instead make the command exit nonzero. Octant does not label every nonzero
exit as an authentication failure and does not retry automatically.

This command channel currently refuses below Full access. It is unavailable to
routines, managed subagents, paired clients and headless callers. It does not
change the AWS temporary-session channel or the one-time HTTPS token card.

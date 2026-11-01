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
do not get a session. The Google Cloud and Azure command lines are not
supported yet.

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

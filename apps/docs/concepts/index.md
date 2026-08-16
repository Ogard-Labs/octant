---
description: The Chat, Work, and Code mode boundaries used throughout Octant.
---

# Concepts

Octant has three server-enforced modes. The mode determines the authority,
workspace binding, and tools available to a thread; it is not a renderer-only
preference.

## Chat

Chat is the conversation surface. Chat Projects are virtual containers with
shared scoped memory and no implicit filesystem or shell access.

## Work

Work is local knowledge work for documents, presentations, spreadsheets,
reports, PDFs, images, and artifacts. Each Work Project binds exactly one
OS-confined project root.

## Code

Code is the repository workspace. Each Code Project binds exactly one repository
root and starts approval-gated unless the user explicitly remembers Full access.
Plan mode remains read-only even when Full access is remembered.

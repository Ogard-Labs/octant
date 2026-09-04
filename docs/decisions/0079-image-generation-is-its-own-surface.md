# 0079. Image generation is its own surface

**Status:** Accepted

## Context

0055 and 0056 define image profiles and the journaled job aggregate, and
leave the invocation path open. The first invocation path was a "Create
image…" action on every Chat, Work, and Code composer, with each job scoped
to the thread the composer belonged to. In use, the action read as noise on
a prompt that is about the thread's work, and a person who wanted an image
had to be in a thread to make one. Generated images were kept in the host's
attachment store either way, so "where do my images go" had an answer the
composer never showed.

## Decision

- Image generation is a workspace surface, **Image generator**, reached from
  the profile menu beside Artifacts and Plugins. The composers no longer carry
  a generation action. Thread workspaces keep showing the images the agent's
  image tool generated for that thread.
- Jobs started from the surface run in one host-wide **library scope**: a
  fourth `ImageJobThreadKind`, `image-library`, with the fixed scope id
  `IMAGE_LIBRARY_SCOPE_ID`. Any registered window of the host may list,
  enqueue, cancel, and read jobs in that scope; the window capability is the
  authority, exactly as it is for the profile list. Thread scopes keep their
  thread-bound authority.
- Artifacts stay where 0056 put them: the managed attachment store, hash
  verified and size bounded. The surface lists every library job and its
  artifacts, so a generated image is kept on the host and findable without a
  thread. Saving into a Project remains the thread-scoped action it was.
- The agent image tool is unchanged: an agent generates into its own thread's
  scope, never into the library.

## Consequences

- Composers lose one control each and the draft workspaces lose the image
  generation prop they only threaded through.
- The profile menu's descriptor list gains `image-library`, available when
  the host serves image generation.
- A future Chat "insert generated image" affordance would attach from the
  library rather than generate in place.

## Related

- 0055 Image generation provider profiles
- 0056 Image generation jobs, adapters, and artifact scope
- 0015 Shell, navigation, and workspace layout

/* SPDX-License-Identifier: GPL-2.0 OR MIT */
#ifndef OCTANT_MEDIATION_BRIDGE_H
#define OCTANT_MEDIATION_BRIDGE_H

#include <linux/types.h>
#include <linux/octant_mediation.h>
struct path;
struct qstr;
struct renamedata;

/* These hooks never wait, allocate, or call the userspace policy broker. */
#ifdef CONFIG_SECURITY_OCTANT_MEDIATION
void octant_namespace_begin(void);
void octant_namespace_end(void);
int octant_namespace_check_rename(const struct renamedata *operation);
bool octant_mediation_restricted(void);
int octant_namespace_prepare(u32 operation, const struct path *source,
	const struct qstr *name, const struct path *destination,
	const struct qstr *new_name, u32 flags);
#else
static inline void octant_namespace_begin(void) {}
static inline void octant_namespace_end(void) {}
static inline int octant_namespace_check_rename(const struct renamedata *operation) { return 0; }
static inline bool octant_mediation_restricted(void) { return false; }
static inline int octant_namespace_prepare(u32 operation, const struct path *source,
	const struct qstr *name, const struct path *destination,
	const struct qstr *new_name, u32 flags) { return 0; }
#endif

static inline void octant_namespace_scope_end(bool *entered)
{
	if (*entered)
		octant_namespace_end();
}

/* Cleanup pairs every early return with end; the guarded VFS operation never
 * waits for the broker and does not hold a lock across userspace inspection. */
#define octant_namespace_scope(condition) \
	bool octant_namespace_entered __attribute__((cleanup(octant_namespace_scope_end))) = \
		(condition) ? (octant_namespace_begin(), true) : false

#endif

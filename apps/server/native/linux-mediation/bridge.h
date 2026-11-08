/* SPDX-License-Identifier: GPL-2.0 OR MIT */
#ifndef OCTANT_MEDIATION_BRIDGE_H
#define OCTANT_MEDIATION_BRIDGE_H

#include <linux/types.h>
#include <linux/octant_mediation.h>
struct path;
struct qstr;
struct renamedata;
struct cred;
struct dentry;
struct file;

/* Private kernel scope identity, never part of the userspace UAPI. */
struct octant_metadata_scope {
	u64 identity;
	int error;
};

/* Epoch/final checks never wait. Preparation may wait and belongs only at the
 * audited user-operation entries, before inode locks and filesystem effects. */
#ifdef CONFIG_SECURITY_OCTANT_MEDIATION
void octant_namespace_begin(void);
void octant_namespace_end(void);
int octant_namespace_check_rename(const struct renamedata *operation);
bool octant_mediation_restricted(void);
int octant_mediation_seek(struct file *file, unsigned int whence);
int octant_mediation_receive_scm(const struct cred *sender);
struct octant_metadata_scope octant_metadata_begin(struct dentry *dentry, u32 operation);
void octant_metadata_end(struct octant_metadata_scope *scope);
int octant_metadata_check_read(struct dentry *dentry);
int octant_metadata_check_write_read(struct dentry *dentry);
int octant_metadata_check_write(struct dentry *dentry);
int octant_namespace_prepare(u32 operation, const struct path *source,
	const struct qstr *name, const struct path *destination,
	const struct qstr *new_name, u32 flags);
#else
static inline void octant_namespace_begin(void) {}
static inline void octant_namespace_end(void) {}
static inline int octant_namespace_check_rename(const struct renamedata *operation) { return 0; }
static inline bool octant_mediation_restricted(void) { return false; }
static inline int octant_mediation_seek(struct file *file, unsigned int whence) { return 0; }
static inline int octant_mediation_receive_scm(const struct cred *sender) { return 0; }
static inline struct octant_metadata_scope octant_metadata_begin(struct dentry *dentry, u32 operation)
{
	return (struct octant_metadata_scope) {};
}
static inline void octant_metadata_end(struct octant_metadata_scope *scope) {}
static inline int octant_metadata_check_read(struct dentry *dentry) { return 0; }
static inline int octant_metadata_check_write_read(struct dentry *dentry) { return 0; }
static inline int octant_metadata_check_write(struct dentry *dentry) { return 0; }
static inline int octant_namespace_prepare(u32 operation, const struct path *source,
	const struct qstr *name, const struct path *destination,
	const struct qstr *new_name, u32 flags) { return 0; }
#endif

/* The automatic end clears even an unused decision on every early return.
 * The caller must already own a stable native dentry and no inode lock. */
#define octant_metadata_scope(dentry, operation) \
	struct octant_metadata_scope octant_metadata_admission \
		__attribute__((cleanup(octant_metadata_end))) = octant_metadata_begin(dentry, operation); \
	if (octant_metadata_admission.error) \
		return octant_metadata_admission.error

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

// SPDX-License-Identifier: GPL-2.0 OR MIT
/*
 * Original deny-only admission bridge. Built only in the disposable guest.
 * Production coverage deliberately stays zero: a compiled hook is not proof
 * that create/truncate, namespace, alias and all data routes are complete.
 */
#include <linux/anon_inodes.h>
#include <linux/binfmts.h>
#include <linux/cred.h>
#include <linux/dcache.h>
#include <linux/path.h>
#include <linux/file.h>
#include <linux/fdtable.h>
#include <linux/fs.h>
#include <linux/init.h>
#include <linux/io_uring.h>
#include <linux/kdev_t.h>
#include <linux/kref.h>
#include <linux/lsm_hooks.h>
#include <linux/magic.h>
#include <linux/miscdevice.h>
#include <linux/mm.h>
#include <linux/mutex.h>
#include <linux/poll.h>
#include <linux/pid.h>
#include <linux/posix_acl.h>
#include <linux/rcupdate.h>
#include <linux/sched.h>
#include <linux/sched/task.h>
#include <linux/slab.h>
#include <linux/spinlock.h>
#include <linux/uaccess.h>
#include <linux/wait.h>
#include "octant_mediation.h"
#include "bridge.h"

struct octant_pending {
	struct octant_mediation_request request;
	bool occupied;
	bool delivered;
	bool answered;
	int decision;
	u64 decision_epoch;
	struct path source;
	struct path destination;
	wait_queue_head_t changed;
};

struct octant_context {
	struct kref references;
	spinlock_t lock;
	struct mutex reader;
	wait_queue_head_t readable;
	struct octant_pending pending[OCTANT_MEDIATION_PENDING];
	kuid_t uid;
	struct pid *broker_pid;
	const struct cred *broker_cred;
	u64 next_id;
	bool dead;
};

struct octant_enrollment {
	struct octant_context *context;
	atomic_t consumed;
};

struct octant_cred {
	struct octant_context *context;
};

struct octant_metadata {
	u64 next_scope;
	u64 scope;
	struct task_struct *owner;
	struct octant_context *context;
	u64 inode;
	u64 epoch;
	u32 device_major;
	u32 device_minor;
	u32 operation;
	bool active;
	bool prepared;
};

/* Per-task rather than per-credential: same-policy threads may propose
 * concurrent namespace operations without replacing each other's token. */
struct octant_task {
	struct octant_metadata metadata;
	struct octant_mediation_request approved;
	u64 mutation_base;
	u64 own_changes;
	u32 mutation_depth;
	bool has_approved;
};

static struct lsm_blob_sizes octant_blobs __ro_after_init = {
	.lbs_cred = sizeof(struct octant_cred),
	.lbs_task = sizeof(struct octant_task),
};
/* Private guest identity, not an assigned upstream LSM userspace ABI number. */
static const struct lsm_id octant_lsm_id = {
	.name = "octant_mediation",
	.id = 0,
};
static atomic_t contexts = ATOMIC_INIT(0);
static DEFINE_SPINLOCK(namespace_lock);
static u64 namespace_epoch = 1;
static u32 active_mutations;
static bool namespace_overflow;
static bool initialized;

static struct octant_cred *octant_cred(const struct cred *cred)
{
	return cred->security + octant_blobs.lbs_cred;
}

bool octant_mediation_restricted(void)
{
	return initialized && octant_cred(current_cred())->context;
}

static struct octant_task *octant_task(void)
{
	return current->security + octant_blobs.lbs_task;
}

void octant_namespace_begin(void)
{
	unsigned long flags;
	struct octant_task *task = initialized ? octant_task() : NULL;
	spin_lock_irqsave(&namespace_lock, flags);
	if (task) {
		if (!task->mutation_depth) {
			task->mutation_base = namespace_epoch;
			task->own_changes = 0;
		}
		task->mutation_depth++;
		task->own_changes++;
	}
	if (namespace_epoch == U64_MAX || active_mutations == U32_MAX)
		namespace_overflow = true;
	else {
		namespace_epoch++;
		active_mutations++;
	}
	spin_unlock_irqrestore(&namespace_lock, flags);
}

void octant_namespace_end(void)
{
	unsigned long flags;
	struct octant_task *task = initialized ? octant_task() : NULL;
	spin_lock_irqsave(&namespace_lock, flags);
	if (!active_mutations || namespace_epoch == U64_MAX)
		namespace_overflow = true;
	else {
		active_mutations--;
		namespace_epoch++;
	}
	if (task) {
		if (!task->mutation_depth)
			namespace_overflow = true;
		else {
			task->mutation_depth--;
			task->own_changes++;
			if (!task->mutation_depth)
				task->has_approved = false;
		}
	}
	spin_unlock_irqrestore(&namespace_lock, flags);
}

/* A forwarded descriptor is not the broker principal. PID references prevent
 * reuse from transferring identity; the captured credentials cannot be replaced
 * by a same-uid process, forked child or an enrolled command. */
static bool broker_authorized(struct octant_context *context)
{
	return task_tgid(current) == context->broker_pid &&
		current_cred() == context->broker_cred &&
		!octant_cred(current_cred())->context;
}

static bool broker_alive(struct octant_context *context)
{
	struct task_struct *owner;
	bool alive;
	rcu_read_lock();
	owner = pid_task(context->broker_pid, PIDTYPE_TGID);
	alive = owner && !READ_ONCE(owner->exit_state);
	rcu_read_unlock();
	return alive;
}

static void release_context(struct kref *reference)
{
	struct octant_context *context = container_of(reference, struct octant_context, references);
	atomic_dec(&contexts);
	put_pid(context->broker_pid);
	put_cred(context->broker_cred);
	kfree(context);
}

static void put_context(struct octant_context *context)
{
	if (context)
		kref_put(&context->references, release_context);
}

static int copy_cred(struct cred *new, const struct cred *old, gfp_t gfp)
{
	struct octant_context *context = octant_cred(old)->context;
	if (context)
		kref_get(&context->references);
	octant_cred(new)->context = context;
	return 0;
}

static void transfer_cred(struct cred *new, const struct cred *old)
{
	copy_cred(new, old, GFP_KERNEL);
}

static void free_cred(struct cred *cred)
{
	put_context(octant_cred(cred)->context);
}

static int admit_request(struct octant_mediation_request *request,
	const struct path *source, const struct path *destination)
{
	struct octant_context *context = octant_cred(current_cred())->context;
	struct octant_pending *pending = NULL;
	unsigned long flags;
	long waited;
	int result, i;
	u64 epoch;
	struct path source_pin = {}, destination_pin = {};
	if (!context)
		return 0;
	spin_lock_irqsave(&namespace_lock, flags);
	epoch = namespace_epoch;
	result = namespace_overflow || active_mutations ? -EAGAIN : 0;
	spin_unlock_irqrestore(&namespace_lock, flags);
	if (result)
		return result;
	spin_lock_irqsave(&context->lock, flags);
	if (context->dead || !broker_alive(context) || context->next_id == U64_MAX) {
		spin_unlock_irqrestore(&context->lock, flags);
		return -EACCES;
	}
	for (i = 0; i < OCTANT_MEDIATION_PENDING; i++)
		if (!context->pending[i].occupied) {
			pending = &context->pending[i];
			break;
		}
	if (!pending) {
		spin_unlock_irqrestore(&context->lock, flags);
		return -EAGAIN;
	}
	if (source) {
		pending->source = *source;
		path_get(&pending->source);
	}
	if (destination) {
		pending->destination = *destination;
		path_get(&pending->destination);
	}
	pending->request = *request;
	pending->request.request_id = ++context->next_id;
	pending->request.namespace_epoch = epoch;
	pending->occupied = true;
	pending->delivered = false;
	pending->answered = false;
	pending->decision = -EACCES;
	spin_unlock_irqrestore(&context->lock, flags);
	wake_up_interruptible(&context->readable);
	waited = wait_event_interruptible_timeout(pending->changed,
		READ_ONCE(pending->answered) || READ_ONCE(context->dead),
		msecs_to_jiffies(OCTANT_MEDIATION_TIMEOUT_MS));
	spin_lock_irqsave(&context->lock, flags);
	result = waited <= 0 || context->dead || !broker_alive(context) ? -EACCES : pending->decision;
	if (!result)
		request->namespace_epoch = pending->decision_epoch;
	source_pin = pending->source;
	destination_pin = pending->destination;
	pending->source = (struct path) {};
	pending->destination = (struct path) {};
	pending->occupied = false;
	spin_unlock_irqrestore(&context->lock, flags);
	if (source_pin.dentry)
		path_put(&source_pin);
	if (destination_pin.dentry)
		path_put(&destination_pin);
	return result;
}

static bool guarded_inode(struct inode *inode)
{
	return inode && (S_ISREG(inode->i_mode) || S_ISDIR(inode->i_mode) || S_ISLNK(inode->i_mode));
}

static int admit_inode_request(struct inode *inode, u32 operation, struct octant_mediation_request *request)
{
	request->operation = operation;
	request->inode = inode->i_ino;
	request->device_major = MAJOR(inode->i_sb->s_dev);
	request->device_minor = MINOR(inode->i_sb->s_dev);
	return admit_request(request, NULL, NULL);
}

static int admit_inode(struct inode *inode, u32 operation)
{
	struct octant_mediation_request request = {};
	if (!octant_mediation_restricted() || !guarded_inode(inode))
		return 0;
	return admit_inode_request(inode, operation, &request);
}

static void clear_metadata(struct octant_metadata *metadata)
{
	u64 next = metadata->next_scope;
	*metadata = (struct octant_metadata) { .next_scope = next };
}

struct octant_metadata_scope octant_metadata_begin(struct dentry *dentry, u32 operation)
{
	struct octant_metadata_scope scope = {};
	struct inode *inode = d_inode(dentry);
	struct octant_metadata *metadata;
	struct octant_mediation_request request = {};
	if (!octant_mediation_restricted() || !guarded_inode(inode))
		return scope;
	metadata = &octant_task()->metadata;
	if (metadata->active || metadata->next_scope == U64_MAX ||
	    (operation != OCTANT_MEDIATION_READ && operation != OCTANT_MEDIATION_WRITE)) {
		scope.error = -EACCES;
		return scope;
	}
	scope.identity = ++metadata->next_scope;
	metadata->scope = scope.identity;
	metadata->owner = current;
	metadata->context = octant_cred(current_cred())->context;
	metadata->active = true;
	metadata->prepared = false;
	scope.error = admit_inode_request(inode, operation, &request);
	if (!scope.error) {
		metadata->inode = request.inode;
		metadata->device_major = request.device_major;
		metadata->device_minor = request.device_minor;
		metadata->operation = operation;
		metadata->epoch = request.namespace_epoch;
		metadata->prepared = true;
	}
	return scope;
}

void octant_metadata_end(struct octant_metadata_scope *scope)
{
	struct octant_metadata *metadata;
	if (!scope->identity || !initialized)
		return;
	metadata = &octant_task()->metadata;
	if (metadata->active && metadata->scope == scope->identity && metadata->owner == current)
		clear_metadata(metadata);
}

/* These final checks can run with an inode lock held. They consume only
 * this task's paired preflight; they never ask the broker or inspect paths. */
static int check_metadata(struct dentry *dentry, u32 operation)
{
	struct inode *inode = d_inode(dentry);
	struct octant_context *context;
	struct octant_metadata *metadata;
	unsigned long flags;
	bool valid;
	if (!octant_mediation_restricted() || !guarded_inode(inode))
		return 0;
	context = octant_cred(current_cred())->context;
	metadata = &octant_task()->metadata;
	spin_lock_irqsave(&context->lock, flags);
	spin_lock(&namespace_lock);
	valid = metadata->active && metadata->prepared && metadata->scope &&
		metadata->owner == current && metadata->context == context &&
		!context->dead && broker_alive(context) && !namespace_overflow && !active_mutations &&
		metadata->epoch == namespace_epoch && metadata->operation == operation &&
		metadata->inode == inode->i_ino &&
		metadata->device_major == MAJOR(inode->i_sb->s_dev) &&
		metadata->device_minor == MINOR(inode->i_sb->s_dev);
	metadata->prepared = false;
	spin_unlock(&namespace_lock);
	spin_unlock_irqrestore(&context->lock, flags);
	return valid ? 0 : -EACCES;
}

/* Audited ordinary mutation entries call this under the actual inode lock,
 * immediately before the filesystem effect. File-attribute writes prepare in
 * their userspace callers, never in the shared/internal setter. Internal and
 * stacked/overridden-credential paths remain unproved, not global coverage. */
int octant_metadata_check_write(struct dentry *dentry)
{
	return check_metadata(dentry, OCTANT_MEDIATION_WRITE);
}

static int octant_metadata_task_alloc(struct task_struct *task, u64 clone_flags)
{
	struct octant_task *state = task->security + octant_blobs.lbs_task;
	memset(&state->metadata, 0, sizeof(state->metadata));
	return 0;
}

static int octant_metadata_getattr(const struct path *path)
{
	return check_metadata(path->dentry, OCTANT_MEDIATION_READ);
}

static int octant_metadata_readlink(struct dentry *dentry)
{
	return check_metadata(dentry, OCTANT_MEDIATION_READ);
}

static int octant_metadata_getxattr(struct dentry *dentry, const char *name)
{
	return check_metadata(dentry, OCTANT_MEDIATION_READ);
}

static int octant_metadata_listxattr(struct dentry *dentry)
{
	return check_metadata(dentry, OCTANT_MEDIATION_READ);
}

static int octant_metadata_get_acl(struct mnt_idmap *idmap, struct dentry *dentry, const char *name)
{
	return check_metadata(dentry, OCTANT_MEDIATION_READ);
}

static int octant_metadata_setxattr(struct mnt_idmap *idmap, struct dentry *dentry,
	const char *name, const void *value, size_t size, int flags)
{
	return check_metadata(dentry, OCTANT_MEDIATION_WRITE);
}

static int octant_metadata_removexattr(struct mnt_idmap *idmap, struct dentry *dentry, const char *name)
{
	return check_metadata(dentry, OCTANT_MEDIATION_WRITE);
}

static int octant_metadata_set_acl(struct mnt_idmap *idmap, struct dentry *dentry, const char *name,
	struct posix_acl *acl)
{
	return check_metadata(dentry, OCTANT_MEDIATION_WRITE);
}

static int octant_metadata_remove_acl(struct mnt_idmap *idmap, struct dentry *dentry, const char *name)
{
	return check_metadata(dentry, OCTANT_MEDIATION_WRITE);
}

static int copy_name(struct octant_mediation_name *output, struct inode *parent,
		     const struct qstr *name)
{
	if (!parent || !name || !name->len || name->len > 255)
		return -EACCES;
	output->parent_inode = parent->i_ino;
	output->device_major = MAJOR(parent->i_sb->s_dev);
	output->device_minor = MINOR(parent->i_sb->s_dev);
	output->length = name->len;
	memcpy(output->bytes, name->name, name->len);
	return 0;
}

int octant_namespace_prepare(u32 operation, const struct path *source,
	const struct qstr *name, const struct path *destination,
	const struct qstr *new_name, u32 flags)
{
	struct octant_mediation_request request = { .operation = operation, .flags = flags };
	struct octant_task *task;
	int result;
	if (!octant_mediation_restricted())
		return 0;
	task = octant_task();
	task->has_approved = false;
	result = copy_name(&request.source, d_inode(source->dentry), name);
	if (!result && destination)
		result = copy_name(&request.destination, d_inode(destination->dentry), new_name);
	if (!result)
		result = admit_request(&request, source, destination);
	if (!result) {
		task->approved = request;
		task->has_approved = true;
	}
	return result;
}

/* Called with the VFS locks held: comparison only, never a broker wait or a
 * pathname lookup. Every unsupported or unprepared path refuses. */
static int check_namespace(u32 operation, struct inode *source, struct dentry *name,
	struct inode *destination, struct dentry *new_name, u32 operation_flags)
{
	struct octant_mediation_request actual = { .operation = operation, .flags = operation_flags };
	struct octant_task *task;
	unsigned long flags;
	bool valid;
	int result;
	if (!octant_mediation_restricted())
		return 0;
	task = octant_task();
	result = copy_name(&actual.source, source, &name->d_name);
	if (!result && destination)
		result = copy_name(&actual.destination, destination, &new_name->d_name);
	if (result)
		return result;
	spin_lock_irqsave(&namespace_lock, flags);
	valid = task->has_approved && !namespace_overflow &&
		!READ_ONCE(octant_cred(current_cred())->context->dead) &&
		broker_alive(octant_cred(current_cred())->context) &&
		task->approved.operation == actual.operation &&
		task->approved.flags == actual.flags &&
		!memcmp(&task->approved.source, &actual.source, sizeof(actual.source)) &&
		!memcmp(&task->approved.destination, &actual.destination, sizeof(actual.destination)) &&
		active_mutations == task->mutation_depth &&
		(task->mutation_depth ?
		 task->approved.namespace_epoch == task->mutation_base &&
		 namespace_epoch >= task->mutation_base &&
		 namespace_epoch - task->mutation_base == task->own_changes :
		 task->approved.namespace_epoch == namespace_epoch);
	task->has_approved = false;
	spin_unlock_irqrestore(&namespace_lock, flags);
	return valid ? 0 : -EACCES;
}

static int check_unlink(struct inode *parent, struct dentry *name)
{
	return check_namespace(OCTANT_MEDIATION_UNLINK, parent, name, NULL, NULL, 0);
}

static int check_rmdir(struct inode *parent, struct dentry *name)
{
	return check_namespace(OCTANT_MEDIATION_RMDIR, parent, name, NULL, NULL, 0);
}

/* inode_rename omits flags and expands EXCHANGE into two callbacks. Keep
 * the original flags at the actual VFS entry, under the same parent locks. */
int octant_namespace_check_rename(const struct renamedata *operation)
{
	return check_namespace(OCTANT_MEDIATION_RENAME,
		d_inode(operation->old_parent), operation->old_dentry,
		d_inode(operation->new_parent), operation->new_dentry, operation->flags);
}

static int admit_file(struct file *file, u32 operation)
{
	return admit_inode(file ? file_inode(file) : NULL, operation);
}

static int truncate_file(struct file *file)
{
	return admit_file(file, OCTANT_MEDIATION_WRITE);
}

static int truncate_path(const struct path *path)
{
	return admit_inode(d_inode(path->dentry), OCTANT_MEDIATION_WRITE);
}

static int octant_file_permission(struct file *file, int mask)
{
	return admit_file(file, mask & MAY_WRITE ? OCTANT_MEDIATION_WRITE : OCTANT_MEDIATION_READ);
}

static int mmap_file(struct file *file, unsigned long requested, unsigned long prot,
		     unsigned long flags)
{
	return admit_file(file, OCTANT_MEDIATION_MAP);
}

static int protect_mapping(struct vm_area_struct *vma, unsigned long requested, unsigned long prot)
{
	return admit_file(vma->vm_file, OCTANT_MEDIATION_MAP);
}

static int check_exec(struct linux_binprm *bprm)
{
	clear_metadata(&octant_task()->metadata);
	return admit_file(bprm->file, OCTANT_MEDIATION_EXEC);
}

/* Credentials are captured at the actual SCM send, retained on the kernel
 * record and released with it. File opener credentials would wrongly reject
 * an inherited ordinary FD later passed between peers of the same policy. */
int octant_mediation_receive_scm(const struct cred *sender)
{
	struct octant_context *ours = octant_cred(current_cred())->context;
	return ours && (!sender || octant_cred(sender)->context != ours) ? -EACCES : 0;
}

static int receive_file(struct file *file)
{
	return octant_cred(current_cred())->context && io_is_uring_fops(file) ? -EACCES : 0;
}

#ifdef CONFIG_IO_URING
static int allow_uring(void)
{
	return octant_cred(current_cred())->context ? -ENOSYS : 0;
}
#endif

static int may_read_process(struct task_struct *target, unsigned int mode)
{
	struct octant_context *ours = octant_cred(current_cred())->context;
	const struct cred *theirs;
	int result;
	if (!ours)
		return 0;
	theirs = get_task_cred(target);
	result = ours == octant_cred(theirs)->context ? 0 : -EACCES;
	put_cred(theirs);
	return result;
}

static bool has_request(struct octant_context *context)
{
	unsigned long flags;
	bool ready = false;
	int i;
	spin_lock_irqsave(&context->lock, flags);
	for (i = 0; i < OCTANT_MEDIATION_PENDING; i++)
		if (context->pending[i].occupied && !context->pending[i].delivered)
			ready = true;
	ready |= context->dead;
	spin_unlock_irqrestore(&context->lock, flags);
	return ready;
}

static ssize_t read_request(struct file *file, char __user *bytes, size_t length, loff_t *position)
{
	struct octant_context *context = file->private_data;
	struct octant_mediation_request request = {0};
	struct octant_pending *oldest = NULL;
	unsigned long flags;
	bool found = false;
	int i, result;
	if (!broker_authorized(context))
		return -EPERM;
	if (length != sizeof(request))
		return -EINVAL;
	if (file->f_flags & O_NONBLOCK && !has_request(context))
		return -EAGAIN;
	result = wait_event_interruptible(context->readable, has_request(context));
	if (result)
		return result;
	if (mutex_lock_interruptible(&context->reader))
		return -EINTR;
	spin_lock_irqsave(&context->lock, flags);
	for (i = 0; i < OCTANT_MEDIATION_PENDING; i++) {
		struct octant_pending *pending = &context->pending[i];
		if (pending->occupied && !pending->delivered &&
		    (!oldest || pending->request.request_id < oldest->request.request_id))
			oldest = pending;
	}
	/* A completed slot may be reused while an older request waits in another
	 * slot. Slot order is not queue order; the broker's replay guard requires
	 * monotonically delivered identities and older work must not starve. */
	if (oldest) {
		request = oldest->request;
		oldest->delivered = true;
		found = true;
	}
	spin_unlock_irqrestore(&context->lock, flags);
	result = !found ? -EAGAIN : copy_to_user(bytes, &request, sizeof(request)) ? -EFAULT : sizeof(request);
	mutex_unlock(&context->reader);
	return result;
}

static ssize_t answer_request(struct file *file, const char __user *bytes, size_t length,
			     loff_t *position)
{
	struct octant_context *context = file->private_data;
	struct octant_mediation_answer answer;
	struct octant_pending *pending = NULL;
	unsigned long flags;
	int i;
	if (!broker_authorized(context))
		return -EPERM;
	if (length != sizeof(answer))
		return -EINVAL;
	if (copy_from_user(&answer, bytes, sizeof(answer)))
		return -EFAULT;
	if (answer.reserved || answer.allow > 1)
		return -EINVAL;
	spin_lock_irqsave(&context->lock, flags);
	for (i = 0; i < OCTANT_MEDIATION_PENDING; i++)
		if (context->pending[i].occupied && context->pending[i].delivered &&
		    !context->pending[i].answered &&
		    context->pending[i].request.request_id == answer.request_id) {
			pending = &context->pending[i];
			break;
		}
	if (!pending || context->dead) {
		spin_unlock_irqrestore(&context->lock, flags);
		return -ENOENT;
	}
	/* The broker scanned without a VFS lock. Only this short final comparison
	 * orders admission against real namespace mutation; it never performs I/O. */
	spin_lock(&namespace_lock);
	pending->decision = !answer.allow ? -EACCES :
		namespace_overflow || active_mutations || namespace_epoch != answer.namespace_epoch ?
		-EAGAIN : 0;
	spin_unlock(&namespace_lock);
	pending->decision_epoch = answer.namespace_epoch;
	pending->answered = true;
	wake_up_interruptible(&pending->changed);
	spin_unlock_irqrestore(&context->lock, flags);
	return sizeof(answer);
}

static __poll_t poll_requests(struct file *file, poll_table *wait)
{
	struct octant_context *context = file->private_data;
	if (!broker_authorized(context))
		return EPOLLERR;
	poll_wait(file, &context->readable, wait);
	if (READ_ONCE(context->dead))
		return EPOLLHUP;
	return has_request(context) ? EPOLLIN | EPOLLRDNORM : 0;
}

static int close_broker(struct inode *inode, struct file *file)
{
	struct octant_context *context = file->private_data;
	unsigned long flags;
	int i;
	spin_lock_irqsave(&context->lock, flags);
	context->dead = true;
	for (i = 0; i < OCTANT_MEDIATION_PENDING; i++)
		wake_up_interruptible(&context->pending[i].changed);
	spin_unlock_irqrestore(&context->lock, flags);
	wake_up_interruptible(&context->readable);
	put_context(context);
	return 0;
}

static int inherited_unsafe_descriptor(const void *unused, struct file *file, unsigned int descriptor)
{
	if (io_is_uring_fops(file) || !IS_ERR(pidfd_pid(file)))
		return -EACCES;
	/* A proc memory FD was authorized against its opener, not this new
	 * workload. Existing directory/O_PATH and ordinary file FDs stay valid. */
	if (file_inode(file)->i_sb->s_magic == PROC_SUPER_MAGIC &&
	    !(file->f_mode & FMODE_PATH) && S_ISREG(file_inode(file)->i_mode))
		return -EACCES;
	return 0;
}

static long enroll(struct file *file, unsigned int command, unsigned long argument)
{
	struct octant_enrollment *enrollment = file->private_data;
	struct octant_context *context = enrollment->context;
	struct cred *cred;
	if (command != OCTANT_MEDIATION_ENROLL || argument)
		return -EINVAL;
	if (!task_no_new_privs(current) || !uid_eq(current_euid(), context->uid) ||
	    octant_cred(current_cred())->context || READ_ONCE(context->dead))
		return -EPERM;
	/* A trusted single-thread bootstrap must finish before untrusted code can
	 * share its address space or descriptor table with an unenrolled peer. */
	if (!current->mm || atomic_read(&current->mm->mm_users) != 1 ||
	    atomic_read(&current->files->count) != 1 ||
	    iterate_fd(current->files, 0, inherited_unsafe_descriptor, NULL))
		return -EPERM;
#ifdef CONFIG_AIO
	if (rcu_access_pointer(current->mm->ioctx_table))
		return -EPERM;
#endif
	if (atomic_cmpxchg(&enrollment->consumed, 0, 1))
		return -EALREADY;
	cred = prepare_creds();
	if (!cred)
		return -ENOMEM;
	kref_get(&context->references);
	octant_cred(cred)->context = context;
	return commit_creds(cred);
}

static int close_enrollment(struct inode *inode, struct file *file)
{
	struct octant_enrollment *enrollment = file->private_data;
	put_context(enrollment->context);
	kfree(enrollment);
	return 0;
}

static const struct file_operations enrollment_operations = {
	.unlocked_ioctl = enroll,
	.compat_ioctl = enroll,
	.release = close_enrollment,
	.llseek = noop_llseek,
};

static long parent_descriptor(struct octant_context *context, unsigned long argument)
{
	struct octant_mediation_parent input;
	struct path parent = {};
	struct file *file;
	unsigned long flags;
	int descriptor, i;
	if (copy_from_user(&input, (void __user *)argument, sizeof(input)))
		return -EFAULT;
	if (input.reserved || input.side > 1)
		return -EINVAL;
	spin_lock_irqsave(&context->lock, flags);
	for (i = 0; i < OCTANT_MEDIATION_PENDING; i++) {
		struct octant_pending *pending = &context->pending[i];
		if (pending->occupied && pending->delivered && !pending->answered &&
		    pending->request.request_id == input.request_id && !context->dead) {
			parent = input.side ? pending->destination : pending->source;
			if (parent.dentry)
				path_get(&parent);
			break;
		}
	}
	spin_unlock_irqrestore(&context->lock, flags);
	if (!parent.dentry)
		return -ENOENT;
	/* The pin is the actual proposal's path/mount, including bind roots. No
	 * guest string is translated into a host pathname or a different mount. */
	file = dentry_open(&parent, O_PATH | O_CLOEXEC, current_cred());
	path_put(&parent);
	if (IS_ERR(file))
		return PTR_ERR(file);
	descriptor = get_unused_fd_flags(O_CLOEXEC);
	if (descriptor < 0)
		fput(file);
	else
		fd_install(descriptor, file);
	return descriptor;
}

static long broker_ioctl(struct file *file, unsigned int command, unsigned long argument)
{
	struct octant_context *context = file->private_data;
	struct octant_mediation_status status = { .abi = OCTANT_MEDIATION_ABI };
	struct octant_enrollment *enrollment;
	unsigned long flags;
	int descriptor;
	if (!broker_authorized(context))
		return -EPERM;
	if (command == OCTANT_MEDIATION_PARENT_FD)
		return parent_descriptor(context, argument);
	if (command == OCTANT_MEDIATION_STATUS) {
		spin_lock_irqsave(&namespace_lock, flags);
		status.namespace_epoch = namespace_epoch;
		status.active_mutations = active_mutations;
		spin_unlock_irqrestore(&namespace_lock, flags);
		return copy_to_user((void __user *)argument, &status, sizeof(status)) ? -EFAULT : 0;
	}
	if (command != OCTANT_MEDIATION_ENROLL_FD || argument)
		return -EINVAL;
	if (octant_cred(current_cred())->context || !uid_eq(current_euid(), context->uid))
		return -EPERM;
	enrollment = kzalloc(sizeof(*enrollment), GFP_KERNEL);
	if (!enrollment)
		return -ENOMEM;
	enrollment->context = context;
	kref_get(&context->references);
	descriptor = anon_inode_getfd("octant-enrollment", &enrollment_operations, enrollment,
		O_RDONLY | O_CLOEXEC);
	if (descriptor < 0) {
		put_context(context);
		kfree(enrollment);
	}
	return descriptor;
}

static int open_broker(struct inode *inode, struct file *file)
{
	struct octant_context *context;
	int i;
	if (octant_cred(current_cred())->context)
		return -EPERM;
	if (atomic_inc_return(&contexts) > 64) {
		atomic_dec(&contexts);
		return -EAGAIN;
	}
	context = kzalloc(sizeof(*context), GFP_KERNEL);
	if (!context) {
		atomic_dec(&contexts);
		return -ENOMEM;
	}
	kref_init(&context->references);
	spin_lock_init(&context->lock);
	mutex_init(&context->reader);
	init_waitqueue_head(&context->readable);
	for (i = 0; i < OCTANT_MEDIATION_PENDING; i++)
		init_waitqueue_head(&context->pending[i].changed);
	context->uid = current_euid();
	context->broker_pid = get_task_pid(current, PIDTYPE_TGID);
	context->broker_cred = get_current_cred();
	file->private_data = context;
	return 0;
}

static const struct file_operations broker_operations = {
	.open = open_broker,
	.read = read_request,
	.write = answer_request,
	.poll = poll_requests,
	.unlocked_ioctl = broker_ioctl,
	.compat_ioctl = broker_ioctl,
	.release = close_broker,
	.llseek = noop_llseek,
};

static struct miscdevice broker_device = {
	.minor = MISC_DYNAMIC_MINOR,
	.name = "octant_mediation",
	.fops = &broker_operations,
	.mode = 0600,
};

static struct security_hook_list octant_hooks[] __ro_after_init = {
	LSM_HOOK_INIT(cred_prepare, copy_cred),
	LSM_HOOK_INIT(cred_transfer, transfer_cred),
	LSM_HOOK_INIT(cred_free, free_cred),
	LSM_HOOK_INIT(file_permission, octant_file_permission),
	LSM_HOOK_INIT(task_alloc, octant_metadata_task_alloc),
	LSM_HOOK_INIT(inode_getattr, octant_metadata_getattr),
	LSM_HOOK_INIT(inode_readlink, octant_metadata_readlink),
	LSM_HOOK_INIT(inode_getxattr, octant_metadata_getxattr),
	LSM_HOOK_INIT(inode_listxattr, octant_metadata_listxattr),
	LSM_HOOK_INIT(inode_get_acl, octant_metadata_get_acl),
	LSM_HOOK_INIT(inode_setxattr, octant_metadata_setxattr),
	LSM_HOOK_INIT(inode_removexattr, octant_metadata_removexattr),
	LSM_HOOK_INIT(inode_set_acl, octant_metadata_set_acl),
	LSM_HOOK_INIT(inode_remove_acl, octant_metadata_remove_acl),
	LSM_HOOK_INIT(inode_unlink, check_unlink),
	LSM_HOOK_INIT(inode_rmdir, check_rmdir),
	LSM_HOOK_INIT(file_truncate, truncate_file),
	LSM_HOOK_INIT(path_truncate, truncate_path),
	LSM_HOOK_INIT(mmap_file, mmap_file),
	LSM_HOOK_INIT(file_mprotect, protect_mapping),
	LSM_HOOK_INIT(bprm_check_security, check_exec),
	LSM_HOOK_INIT(file_receive, receive_file),
	LSM_HOOK_INIT(ptrace_access_check, may_read_process),
#ifdef CONFIG_IO_URING
	LSM_HOOK_INIT(uring_allowed, allow_uring),
#endif
};

static int __init octant_security_init(void)
{
	security_add_hooks(octant_hooks, ARRAY_SIZE(octant_hooks), &octant_lsm_id);
	initialized = true;
	pr_info("Octant mediation: experimental production coverage=0\n");
	return 0;
}

static int __init octant_device_init(void)
{
	return initialized ? misc_register(&broker_device) : 0;
}
device_initcall(octant_device_init);

DEFINE_LSM(octant_mediation) = {
	.name = "octant_mediation",
	.init = octant_security_init,
	.blobs = &octant_blobs,
};

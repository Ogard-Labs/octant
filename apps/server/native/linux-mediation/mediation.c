// SPDX-License-Identifier: GPL-2.0 OR MIT
/*
 * Original deny-only admission bridge. Built only in the disposable guest.
 * Production coverage deliberately stays zero: a compiled hook is not proof
 * that create/truncate, namespace, alias and all data routes are complete.
 */
#include <linux/anon_inodes.h>
#include <linux/binfmts.h>
#include <linux/cred.h>
#include <linux/file.h>
#include <linux/fdtable.h>
#include <linux/fs.h>
#include <linux/init.h>
#include <linux/io_uring.h>
#include <linux/kdev_t.h>
#include <linux/kref.h>
#include <linux/lsm_hooks.h>
#include <linux/miscdevice.h>
#include <linux/mm.h>
#include <linux/mutex.h>
#include <linux/poll.h>
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
	wait_queue_head_t changed;
};

struct octant_context {
	struct kref references;
	spinlock_t lock;
	struct mutex reader;
	wait_queue_head_t readable;
	struct octant_pending pending[OCTANT_MEDIATION_PENDING];
	kuid_t uid;
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

static struct lsm_blob_sizes octant_blobs __ro_after_init = {
	.lbs_cred = sizeof(struct octant_cred),
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

void octant_namespace_begin(void)
{
	unsigned long flags;
	spin_lock_irqsave(&namespace_lock, flags);
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
	spin_lock_irqsave(&namespace_lock, flags);
	if (!active_mutations || namespace_epoch == U64_MAX)
		namespace_overflow = true;
	else {
		active_mutations--;
		namespace_epoch++;
	}
	spin_unlock_irqrestore(&namespace_lock, flags);
}

static void release_context(struct kref *reference)
{
	struct octant_context *context = container_of(reference, struct octant_context, references);
	atomic_dec(&contexts);
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

static int admit_inode(struct inode *inode, u32 operation)
{
	struct octant_context *context = octant_cred(current_cred())->context;
	struct octant_pending *pending = NULL;
	unsigned long flags;
	long waited;
	int result, i;
	u64 epoch;
	if (!context || !inode || !S_ISREG(inode->i_mode))
		return 0;
	spin_lock_irqsave(&namespace_lock, flags);
	epoch = namespace_epoch;
	result = namespace_overflow || active_mutations ? -EAGAIN : 0;
	spin_unlock_irqrestore(&namespace_lock, flags);
	if (result)
		return result;
	spin_lock_irqsave(&context->lock, flags);
	if (context->dead || context->next_id == U64_MAX) {
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
	pending->request = (struct octant_mediation_request) {
		.request_id = ++context->next_id,
		.namespace_epoch = epoch,
		.inode = inode->i_ino,
		.device_major = MAJOR(inode->i_sb->s_dev),
		.device_minor = MINOR(inode->i_sb->s_dev),
		.operation = operation,
	};
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
	result = waited <= 0 || context->dead ? -EACCES : pending->decision;
	pending->occupied = false;
	spin_unlock_irqrestore(&context->lock, flags);
	return result;
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
	return admit_file(bprm->file, OCTANT_MEDIATION_EXEC);
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
	unsigned long flags;
	bool found = false;
	int i, result;
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
		if (pending->occupied && !pending->delivered) {
			request = pending->request;
			pending->delivered = true;
			found = true;
			break;
		}
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
	pending->answered = true;
	wake_up_interruptible(&pending->changed);
	spin_unlock_irqrestore(&context->lock, flags);
	return sizeof(answer);
}

static __poll_t poll_requests(struct file *file, poll_table *wait)
{
	struct octant_context *context = file->private_data;
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

static int inherited_ring(const void *unused, struct file *file, unsigned int descriptor)
{
	return io_is_uring_fops(file) ? -EACCES : 0;
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
	    iterate_fd(current->files, 0, inherited_ring, NULL))
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

static long broker_ioctl(struct file *file, unsigned int command, unsigned long argument)
{
	struct octant_context *context = file->private_data;
	struct octant_mediation_status status = { .abi = OCTANT_MEDIATION_ABI };
	struct octant_enrollment *enrollment;
	unsigned long flags;
	int descriptor;
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

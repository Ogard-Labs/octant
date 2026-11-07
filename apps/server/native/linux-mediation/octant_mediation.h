/* SPDX-License-Identifier: (GPL-2.0 WITH Linux-syscall-note) OR MIT */
#ifndef OCTANT_MEDIATION_UAPI_H
#define OCTANT_MEDIATION_UAPI_H

#include <linux/ioctl.h>
#include <linux/types.h>

#define OCTANT_MEDIATION_ABI 1
#define OCTANT_MEDIATION_PENDING 32
#define OCTANT_MEDIATION_TIMEOUT_MS 2000

/* Object identity comes from the kernel-held file, never a workload pathname. */
struct octant_mediation_request {
	__u64 request_id;
	__u64 namespace_epoch;
	__u64 inode;
	__u32 device_major;
	__u32 device_minor;
	__u32 operation;
	__u32 reserved;
};

struct octant_mediation_answer {
	__u64 request_id;
	__u64 namespace_epoch;
	__u32 allow;
	__u32 reserved;
};

struct octant_mediation_status {
	__u64 namespace_epoch;
	__u32 active_mutations;
	__u32 abi;
	/* Zero until every production admission and mutation route is implemented. */
	__u64 production_coverage;
};

#define OCTANT_MEDIATION_READ 1
#define OCTANT_MEDIATION_WRITE 2
#define OCTANT_MEDIATION_MAP 3
#define OCTANT_MEDIATION_EXEC 4

/* Returns a one-use close-on-exec enrollment descriptor; no broker FD crosses. */
#define OCTANT_MEDIATION_ENROLL_FD _IO('O', 0x71)
#define OCTANT_MEDIATION_ENROLL _IO('O', 0x72)
#define OCTANT_MEDIATION_STATUS _IOR('O', 0x73, struct octant_mediation_status)

#endif

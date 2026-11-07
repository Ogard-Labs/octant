/* SPDX-License-Identifier: GPL-2.0 OR MIT */
#ifndef OCTANT_MEDIATION_BRIDGE_H
#define OCTANT_MEDIATION_BRIDGE_H

/* These hooks never wait, allocate, or call the userspace policy broker. */
#ifdef CONFIG_SECURITY_OCTANT_MEDIATION
void octant_namespace_begin(void);
void octant_namespace_end(void);
#else
static inline void octant_namespace_begin(void) {}
static inline void octant_namespace_end(void) {}
#endif

#endif

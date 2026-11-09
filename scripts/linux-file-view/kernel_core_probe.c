/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>

int main(void)
{
  alarm(3);
  struct rlimit limit;
  long size = sysconf(_SC_PAGESIZE);
  if (size <= 0 || getrlimit(RLIMIT_CORE, &limit) || limit.rlim_cur != 0) return 1;
  void *page = mmap(NULL, (size_t)size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (page == MAP_FAILED) return 2;
  dprintf(STDOUT_FILENO, "OCTANT_CORE_PROBE_ADDRESS {\"pid\":%ld,\"address\":\"0x%llx\",\"coreSoft\":0}\n",
    (long)getpid(), (unsigned long long)(uintptr_t)page);
  *(volatile unsigned char *)page = 0x5a;
  return 3;
}

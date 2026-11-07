#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Compatibility measurement only: this is not a filesystem policy. */
static const int calls[] = {
  SYS_io_uring_setup, SYS_io_uring_enter, SYS_io_uring_register,
  SYS_io_setup, SYS_io_submit, SYS_io_cancel, SYS_io_getevents,
  SYS_io_pgetevents, SYS_io_destroy,
};

int main(int count, char **arguments) {
  if (count == 3 && strcmp(arguments[1], "check") == 0) {
    int expected = atoi(arguments[2]);
    unsigned refused = 0;
    for (unsigned i = 0; i < sizeof(calls) / sizeof(calls[0]); i++) {
      errno = 0;
      if (syscall(calls[i], 0, 0, 0, 0, 0, 0) == -1 && errno == expected) refused++;
    }
    printf("{\"refused\":%u,\"expected\":%zu,\"errno\":%d}\n", refused,
      sizeof(calls) / sizeof(calls[0]), expected);
    return refused == sizeof(calls) / sizeof(calls[0]) ? 0 : 1;
  }
  if (count < 4 || (strcmp(arguments[1], "EPERM") && strcmp(arguments[1], "ENOSYS"))) return 2;
#if !defined(__x86_64__)
  fputs("This bounded compatibility fixture requires x86_64 Linux.\n", stderr);
  return 2;
#else
  int refusal = strcmp(arguments[1], "EPERM") == 0 ? EPERM : ENOSYS;
  struct sock_filter filter[32];
  unsigned used = 0;
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  filter[used++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  filter[used++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1);
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | refusal);
  for (unsigned i = 0; i < sizeof(calls) / sizeof(calls[0]); i++) {
    filter[used++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, calls[i], 0, 1);
    filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | refusal);
  }
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog program = { .len = used, .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) {
    perror("compatibility seccomp");
    return 2;
  }
  execvp(arguments[2], &arguments[2]);
  perror("compatibility exec");
  return 2;
#endif
}

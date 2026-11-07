#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/io_uring.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/ptrace.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* One negative feasibility experiment, never a policy or production tracer. */
#define HELD_FD 100
static const char sentinel[] = "synthetic-inode";
static volatile sig_atomic_t interrupted;
struct result {
  int setup_error;
  int pread_error;
  int mmap_error;
  int completion;
  bool submitted;
  bool matched;
};

static void stop(int number) { interrupted = number; }
static unsigned load(unsigned *address) {
  return atomic_load_explicit((_Atomic unsigned *)address, memory_order_acquire);
}
static void publish(unsigned *address, unsigned value) {
  atomic_store_explicit((_Atomic unsigned *)address, value, memory_order_release);
}
static int64_t milliseconds(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) return -1;
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static void client(const char *path, struct result *answer) {
  alarm(10);
  if (ptrace(PTRACE_TRACEME, 0, NULL, NULL)) _exit(2);
  raise(SIGSTOP);
  int file = open(path, O_RDONLY | O_CLOEXEC);
  if (file < 0 || dup2(file, HELD_FD) != HELD_FD) _exit(3);
  close(file);
  struct io_uring_params parameters = {0};
  parameters.flags = IORING_SETUP_SQPOLL;
  parameters.sq_thread_idle = 10000;
  int ring = (int)syscall(SYS_io_uring_setup, 8, &parameters);
  if (ring < 0) { answer->setup_error = errno; _exit(4); }
  if (!(parameters.features & IORING_FEAT_SQPOLL_NONFIXED)) {
    answer->setup_error = EOPNOTSUPP;
    _exit(4);
  }
  size_t sq_size = parameters.sq_off.array + parameters.sq_entries * sizeof(unsigned);
  size_t cq_size = parameters.cq_off.cqes + parameters.cq_entries * sizeof(struct io_uring_cqe);
  if (parameters.features & IORING_FEAT_SINGLE_MMAP) {
    if (cq_size > sq_size) sq_size = cq_size;
    cq_size = sq_size;
  }
  char *sq = mmap(NULL, sq_size, PROT_READ | PROT_WRITE, MAP_SHARED, ring, IORING_OFF_SQ_RING);
  char *cq = parameters.features & IORING_FEAT_SINGLE_MMAP
    ? sq : mmap(NULL, cq_size, PROT_READ | PROT_WRITE, MAP_SHARED, ring, IORING_OFF_CQ_RING);
  struct io_uring_sqe *entries = mmap(NULL, parameters.sq_entries * sizeof(*entries),
    PROT_READ | PROT_WRITE, MAP_SHARED, ring, IORING_OFF_SQES);
  if (sq == MAP_FAILED || cq == MAP_FAILED || entries == MAP_FAILED) _exit(5);

  /* A newly created idle poller may already sleep; wake it before transition. */
  entries[0].opcode = IORING_OP_NOP;
  ((unsigned *)(sq + parameters.sq_off.array))[0] = 0;
  publish((unsigned *)(sq + parameters.sq_off.tail), 1);
  if (syscall(SYS_io_uring_enter, ring, 0, 1,
      IORING_ENTER_SQ_WAKEUP | IORING_ENTER_GETEVENTS, NULL, 0) < 0) {
    answer->setup_error = errno;
    _exit(5);
  }
  unsigned *warm_head = (unsigned *)(cq + parameters.cq_off.head);
  if (load(warm_head) == load((unsigned *)(cq + parameters.cq_off.tail))) _exit(5);
  publish(warm_head, load(warm_head) + 1);

  /* The parent creates the companion at this entry stop, before either access. */
  syscall(SYS_getppid);
  char bytes[64] = {0};
  if (pread(HELD_FD, bytes, sizeof(bytes), 0) < 0) answer->pread_error = errno;
  void *mapped = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, HELD_FD, 0);
  if (mapped == MAP_FAILED) answer->mmap_error = errno;
  else munmap(mapped, 4096);

  unsigned *tail = (unsigned *)(sq + parameters.sq_off.tail);
  unsigned next = load(tail);
  unsigned index = next & load((unsigned *)(sq + parameters.sq_off.ring_mask));
  memset(&entries[index], 0, sizeof(entries[index]));
  entries[index].opcode = IORING_OP_READ;
  entries[index].fd = HELD_FD;
  entries[index].addr = (uintptr_t)bytes;
  entries[index].len = sizeof(bytes);
  entries[index].user_data = 1;
  ((unsigned *)(sq + parameters.sq_off.array))[index] = index;
  answer->submitted = true;
  publish(tail, next + 1);
  /* Never wake/enter the ring: a read must execute without a syscall stop. */
  int64_t deadline = milliseconds() + 1500;
  unsigned *head = (unsigned *)(cq + parameters.cq_off.head);
  unsigned *completed = (unsigned *)(cq + parameters.cq_off.tail);
  while (load(head) == load(completed)) {
    if (milliseconds() >= deadline) { answer->completion = -ETIMEDOUT; _exit(6); }
  }
  unsigned slot = load(head) & load((unsigned *)(cq + parameters.cq_off.ring_mask));
  struct io_uring_cqe *event = &((struct io_uring_cqe *)(cq + parameters.cq_off.cqes))[slot];
  answer->completion = event->res;
  answer->matched = event->res == (int)sizeof(sentinel) - 1 &&
    memcmp(bytes, sentinel, sizeof(sentinel) - 1) == 0;
  publish(head, load(head) + 1);
  _exit(0);
}

int main(void) {
#if !defined(__x86_64__)
  puts("{\"status\":\"blocked\",\"reason\":\"x86_64 fixture required\",\"productionReady\":false}");
  return 1;
#else
  struct sigaction action = {0};
  action.sa_handler = stop;
  sigemptyset(&action.sa_mask);
  sigaction(SIGALRM, &action, NULL);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  alarm(15);
  struct result *answer = mmap(NULL, sizeof(*answer), PROT_READ | PROT_WRITE,
    MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (answer == MAP_FAILED) return 1;
  char directory[] = "/tmp/octant-syscall-admission-XXXXXX";
  if (!mkdtemp(directory)) return 1;
  struct stat owner;
  bool have_identity = lstat(directory, &owner) == 0;
  char path[256], companion[260];
  snprintf(path, sizeof(path), "%s/custom", directory);
  snprintf(companion, sizeof(companion), "%s.pub", path);
  int fixture = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  bool ready = fixture >= 0 && write(fixture, sentinel, sizeof(sentinel) - 1) == (ssize_t)sizeof(sentinel) - 1;
  if (fixture >= 0) close(fixture);
  pid_t child = ready ? fork() : -1;
  if (child == 0) client(path, answer);
  bool reaped = child < 0, protected = false, entering = true, skipped = false;
  bool trace_ready = false;
  int status = 0, denied_reads = 0, denied_maps = 0, enters_after_transition = 0;
  if (child > 0 && waitpid(child, &status, 0) == child) {
    reaped = WIFEXITED(status) || WIFSIGNALED(status);
    if (WIFSTOPPED(status)) {
      long options = PTRACE_O_EXITKILL | PTRACE_O_TRACESYSGOOD |
        PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK | PTRACE_O_TRACECLONE;
      trace_ready = ptrace(PTRACE_SETOPTIONS, child, NULL, (void *)options) == 0;
    }
  }
  while (trace_ready && !interrupted) {
    if (ptrace(PTRACE_SYSCALL, child, NULL, NULL)) break;
    pid_t waited;
    do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR && !interrupted);
    if (waited != child) break;
    if (WIFEXITED(status) || WIFSIGNALED(status)) { reaped = true; break; }
    if (!WIFSTOPPED(status) || WSTOPSIG(status) != (SIGTRAP | 0x80)) break;
    struct user_regs_struct registers;
    if (ptrace(PTRACE_GETREGS, child, NULL, &registers)) break;
    if (entering) {
      if (registers.orig_rax == SYS_getppid && !protected) {
        int public = open(companion, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        protected = public >= 0;
        if (public >= 0) close(public);
        if (!protected) break;
      }
      if (protected && registers.orig_rax == SYS_io_uring_enter) enters_after_transition++;
      bool read = protected && registers.orig_rax == SYS_pread64 && registers.rdi == HELD_FD;
      bool map = protected && registers.orig_rax == SYS_mmap && registers.r8 == HELD_FD;
      skipped = read || map;
      if (skipped) {
        if (read) denied_reads++;
        if (map) denied_maps++;
        registers.orig_rax = (unsigned long)-1;
        if (ptrace(PTRACE_SETREGS, child, NULL, &registers)) break;
      }
    } else if (skipped) {
      registers.rax = (unsigned long)-EACCES;
      if (ptrace(PTRACE_SETREGS, child, NULL, &registers)) break;
      skipped = false;
    }
    entering = !entering;
  }
  if (child > 0 && !reaped) {
    kill(child, SIGKILL);
    pid_t waited;
    do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
    reaped = waited == child;
  }
  alarm(0);
  struct stat current;
  bool same_directory = have_identity && lstat(directory, &current) == 0 &&
    current.st_dev == owner.st_dev && current.st_ino == owner.st_ino && S_ISDIR(current.st_mode);
  bool removed = false;
  if (same_directory && reaped) {
    unlink(companion);
    unlink(path);
    removed = rmdir(directory) == 0;
  }
  bool controls = protected && denied_reads == 1 && denied_maps == 1 &&
    answer->pread_error == EACCES && answer->mmap_error == EACCES;
  bool measured = controls && answer->submitted && answer->matched &&
    enters_after_transition == 0 && reaped && removed && !interrupted;
  struct utsname system = {0};
  uname(&system);
  printf("{\"kind\":\"syscall-entry-counterexample\",\"kernel\":\"%s\","
    "\"status\":\"%s\",\"productionReady\":false,\"setupError\":%d,"
    "\"directReadDenied\":%s,\"newMappingDenied\":%s,\"ringSubmitted\":%s,"
    "\"ringCompletion\":%d,\"ringReadMatched\":%s,\"ringEnterCallsAfterTransition\":%d,"
    "\"ownedChildReaped\":%s,\"fixtureRemoved\":%s}\n",
    system.release, measured ? "measured-counterexample" : "blocked", answer->setup_error,
    answer->pread_error == EACCES ? "true" : "false",
    answer->mmap_error == EACCES ? "true" : "false", answer->submitted ? "true" : "false",
    answer->completion, answer->matched ? "true" : "false", enters_after_transition,
    reaped ? "true" : "false", removed ? "true" : "false");
  munmap(answer, sizeof(*answer));
  return measured ? 0 : 1;
#endif
}

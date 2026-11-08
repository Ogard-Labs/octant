/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <elf.h>
#include <stddef.h>
#include <sys/procfs.h>
#include <sys/user.h>
_Static_assert(sizeof(struct elf_prstatus) == 336, "native status note differs");
_Static_assert(offsetof(struct elf_prstatus, pr_pid) == 32, "native pid offset differs");
_Static_assert(offsetof(struct elf_prstatus, pr_reg) == 112, "native register offset differs");
_Static_assert(sizeof(struct user_regs_struct) == 216, "native register layout differs");
_Static_assert(offsetof(struct user_regs_struct, rip) == 128, "native pc offset differs");
_Static_assert(sizeof(struct elf_prpsinfo) == 136, "native process note differs");
_Static_assert(sizeof(siginfo_t) == 128 && offsetof(siginfo_t, si_addr) == 16,
  "native signal note differs");
_Static_assert(NT_SIGINFO == 0x53494749, "native signal note type differs");
#endif

#define PREFIX_MAX (128u * 1024u)
struct input { int fd; size_t bytes; long long deadline; };
struct notes {
  uint64_t rip, rsp, rbp, rsi, rdx, rax, address, first_load;
  int code;
};
static long long milliseconds(void)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_sec > LLONG_MAX / 1000 - 1) return LLONG_MAX;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static long long deadline(unsigned budget)
{
  long long now = milliseconds();
  return now > LLONG_MAX - budget ? LLONG_MAX : now + budget;
}
static uint16_t u16(const unsigned char *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t u32(const unsigned char *p)
{
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t u64(const unsigned char *p) { return u32(p) | ((uint64_t)u32(p + 4) << 32); }
static bool take(struct input *input, void *data, size_t size)
{
  if (size > PREFIX_MAX - input->bytes) { errno = EFBIG; return false; }
  size_t offset = 0;
  while (offset < size) {
    long long remaining = input->deadline - milliseconds();
    if (remaining <= 0) { errno = ETIMEDOUT; return false; }
    struct pollfd ready = {.fd = input->fd, .events = POLLIN};
    int result = poll(&ready, 1, remaining > 3000 ? 3000 : (int)remaining);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0) { if (!result) errno = ETIMEDOUT; return false; }
    ssize_t count = read(input->fd, (char *)data + offset, size - offset);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count <= 0) { if (!count) errno = ENODATA; return false; }
    offset += (size_t)count;
    input->bytes += (size_t)count;
  }
  return true;
}
static bool discard(struct input *input, size_t size)
{
  unsigned char bytes[32];
  while (size) {
    size_t chunk = size > sizeof(bytes) ? sizeof(bytes) : size;
    if (!take(input, bytes, chunk)) return false;
    size -= chunk;
  }
  return true;
}

/* Linux 6.18 writes headers, then the dumping thread's PRSTATUS, PRPSINFO and
 * SIGINFO before any other notes or memory. Stop immediately after SIGINFO.
 * No EOF drain, heap access, raw note persistence or process strings. */
static bool decode(struct input *input, uint32_t tid, unsigned signal, struct notes *notes)
{
  unsigned char header[64], program[56], value[336], name[8];
  if (!take(input, header, sizeof(header)) || memcmp(header, "\177ELF\2\1\1", 7) ||
      u16(header + 16) != 4 || u16(header + 18) != 62 || u32(header + 20) != 1 ||
      u64(header + 32) != 64 || u16(header + 52) != 64 || u16(header + 54) != 56) return false;
  unsigned count = u16(header + 56);
  if (!count || count > 2048) return false;
  uint64_t end = 0, load = UINT64_MAX;
  for (unsigned index = 0; index < count; index++) {
    if (!take(input, program, sizeof(program))) return false;
    uint64_t start = u64(program + 8), size = u64(program + 32);
    if (!index) {
      if (u32(program) != 4 || start != 64u + (uint64_t)count * 56 ||
          size > UINT64_MAX - start) return false;
      end = start + size;
    } else {
      if (u32(program) != 1 || start < end) return false;
      if (start < load) load = start;
    }
  }
  if (load == UINT64_MAX) return false;
  const uint32_t types[3] = {1, 3, 0x53494749};
  const size_t sizes[3] = {336, 136, 128};
  for (unsigned index = 0; index < 3; index++) {
    if (input->bytes > end || end - input->bytes < 12 ||
        !take(input, header, 12) || u32(header) != 5 ||
        u32(header + 4) != sizes[index] || u32(header + 8) != types[index] ||
        input->bytes > end || end - input->bytes < 8 + sizes[index] ||
        !take(input, name, sizeof(name)) || memcmp(name, "CORE\0", 5)) return false;
    if (index == 1) {
      if (!discard(input, sizes[index])) return false;
      continue;
    }
    if (!take(input, value, sizes[index])) return false;
    if (!index) {
      if (u16(value + 12) != signal || u32(value + 32) != tid || u32(value + 36) != 1) return false;
      notes->rbp = u64(value + 112 + 4 * 8);
      notes->rax = u64(value + 112 + 10 * 8);
      notes->rdx = u64(value + 112 + 12 * 8);
      notes->rsi = u64(value + 112 + 13 * 8);
      notes->rip = u64(value + 112 + 16 * 8);
      notes->rsp = u64(value + 112 + 19 * 8);
    } else {
      if (u32(value) != signal) return false;
      notes->code = (int32_t)u32(value + 8);
      notes->address = notes->code > 0 && signal == SIGSEGV ? u64(value + 16) : 0;
    }
  }
  notes->first_load = load;
  return input->bytes <= end && end <= load;
}

#ifndef OCTANT_CORE_NOTES_TEST
static int console = -1;
static void interrupted(int signal)
{
  static const char message[] = "OCTANT_CORE_NOTES {\"confirmed\":false,\"stage\":\"interrupted\"}\n";
  if (console >= 0) (void)write(console, message, sizeof(message) - 1);
  _exit(signal == SIGALRM ? 124 : 125);
}
static bool number(const char *text, uint64_t *value)
{
  if (!text[0]) return false;
  for (const char *at = text; *at; at++) if (*at < '0' || *at > '9') return false;
  char *end;
  errno = 0;
  unsigned long long result = strtoull(text, &end, 10);
  if (errno || *end) return false;
  *value = result;
  return true;
}
static bool identity(uint64_t pid, uint64_t role, uint64_t device, uint64_t inode)
{
  const char *expected = role == 1 ? "/policy-broker" : role == 2 ? "/core-probe" : NULL;
  if (!expected || !pid || pid > INT_MAX) return false;
  char path[64], info[513];
  struct stat actual = {0}, installed = {0}, target_ns = {0}, initial_ns = {0};
  snprintf(path, sizeof(path), "/proc/%llu/exe", (unsigned long long)pid);
  int file = open(path, O_PATH | O_CLOEXEC);
  bool matched = file >= 0 && !fstat(file, &actual) && !stat(expected, &installed) &&
    S_ISREG(actual.st_mode) && (uint64_t)actual.st_dev == device && (uint64_t)actual.st_ino == inode &&
    actual.st_dev == installed.st_dev && actual.st_ino == installed.st_ino;
  if (file >= 0) close(file);
  if (!matched) return false;
  snprintf(path, sizeof(path), "/proc/%llu/ns/pid", (unsigned long long)pid);
  if (stat(path, &target_ns) || stat("/proc/1/ns/pid", &initial_ns) ||
      target_ns.st_dev != initial_ns.st_dev || target_ns.st_ino != initial_ns.st_ino) return false;
  file = open("/proc/self/fdinfo/3", O_RDONLY | O_CLOEXEC);
  ssize_t size = file >= 0 ? read(file, info, sizeof(info) - 1) : -1;
  if (file >= 0) close(file);
  if (size <= 0) return false;
  info[size] = 0;
  for (char *line = info; line && *line;) {
    unsigned long long target;
    if (sscanf(line, "Pid: %llu", &target) == 1) return target == pid;
    line = strchr(line, '\n');
    if (line) line++;
  }
  return false;
}
int main(int argc, char **argv)
{
  signal(SIGALRM, interrupted); signal(SIGTERM, interrupted); signal(SIGINT, interrupted);
  alarm(3);
  if (argc == 2 && !strcmp(argv[1], "inactive")) _exit(0);
  console = open("/dev/console", O_WRONLY | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  uint64_t args[8] = {0};
  bool owned = argc == 9;
  for (int index = 1; index < argc && owned; index++) owned = number(argv[index], &args[index - 1]);
  owned = owned && args[0] == args[4] && args[1] > 0 && args[1] <= INT_MAX &&
    args[2] > 0 && args[2] < 65 && args[3] == 3 && identity(args[0], args[5], args[6], args[7]);
  struct input input = {.fd = STDIN_FILENO, .deadline = deadline(3000)};
  struct notes notes = {0};
  int flags = fcntl(STDIN_FILENO, F_GETFL);
  bool readable = owned && flags >= 0 && !fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
  int failure = readable ? 0 : errno;
  errno = 0;
  bool confirmed = readable && decode(&input, (uint32_t)args[1], (unsigned)args[2], &notes);
  if (readable && !confirmed) failure = errno;
  if (!confirmed) notes = (struct notes) {0};
  const char *stage = !owned ? "identity" : !readable ? "stdin" : confirmed ? "notes" :
    failure == ETIMEDOUT ? "timeout" : failure == ENODATA ? "truncated" : "invalid-notes";
  char result[2048];
  int length = snprintf(result, sizeof(result),
    "OCTANT_CORE_NOTES {\"confirmed\":%s,\"stage\":\"%s\",\"owned\":%s,\"pidfdValidated\":%s,\"pid\":%llu,\"tid\":%llu,\"role\":%llu,\"helperPid\":%ld,\"device\":%llu,\"inode\":%llu,\"signal\":%llu,\"siCode\":%d,\"hardwareFault\":%s,\"terminationContext\":true,\"errno\":%d,\"bytes\":%zu,\"firstLoad\":%llu,\"beforeMemory\":%s,\"address\":\"0x%llx\",\"rip\":\"0x%llx\",\"rsp\":\"0x%llx\",\"rbp\":\"0x%llx\",\"rsi\":\"0x%llx\",\"rdx\":\"0x%llx\",\"rax\":\"0x%llx\"}\n",
    confirmed ? "true" : "false", stage, owned ? "true" : "false", owned ? "true" : "false",
    (unsigned long long)args[0], (unsigned long long)args[1], (unsigned long long)args[5], (long)getpid(),
    (unsigned long long)args[6], (unsigned long long)args[7], (unsigned long long)args[2], notes.code,
    confirmed && args[2] == SIGSEGV && notes.code > 0 ? "true" : "false", failure, input.bytes,
    (unsigned long long)notes.first_load, confirmed ? "true" : "false", (unsigned long long)notes.address,
    (unsigned long long)notes.rip, (unsigned long long)notes.rsp, (unsigned long long)notes.rbp,
    (unsigned long long)notes.rsi, (unsigned long long)notes.rdx, (unsigned long long)notes.rax);
  if (console >= 0 && length > 0 && length < (int)sizeof(result)) {
    size_t written = 0;
    while (written < (size_t)length && milliseconds() < input.deadline) {
      ssize_t count = write(console, result + written, (size_t)length - written);
      if (count > 0) written += (size_t)count;
      else if (count < 0 && (errno == EINTR || errno == EAGAIN)) {
        struct pollfd ready = {.fd = console, .events = POLLOUT};
        (void)poll(&ready, 1, 10);
      } else break;
    }
  }
  /* Keep fd0 open until our own exit closes it. The kernel's pipe limit waits
   * for that release; never drain the pipe or read the memory segments. */
  _exit(confirmed ? 0 : 1);
}
#else
static void put16(unsigned char *p, uint16_t v) { p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8); }
static void put32(unsigned char *p, uint32_t v) { for (unsigned i = 0; i < 4; i++) p[i] = (unsigned char)(v >> (8 * i)); }
static void put64(unsigned char *p, uint64_t v) { for (unsigned i = 0; i < 8; i++) p[i] = (unsigned char)(v >> (8 * i)); }
static size_t fixture(unsigned char *bytes)
{
  memset(bytes, 0, 8192); memcpy(bytes, "\177ELF\2\1\1", 7);
  put16(bytes + 16, 4); put16(bytes + 18, 62); put32(bytes + 20, 1);
  put64(bytes + 32, 64); put16(bytes + 52, 64); put16(bytes + 54, 56); put16(bytes + 56, 2);
  put32(bytes + 64, 4); put64(bytes + 72, 176); put64(bytes + 96, 660);
  put32(bytes + 120, 1); put32(bytes + 124, 6); put64(bytes + 128, 4096);
  put64(bytes + 136, 0x12345000); put64(bytes + 152, 16); put64(bytes + 160, 4096); put64(bytes + 168, 4096);
  const uint32_t types[3] = {1, 3, 0x53494749}; const unsigned sizes[3] = {336, 136, 128};
  size_t at = 176;
  for (unsigned i = 0; i < 3; i++) {
    put32(bytes + at, 5); put32(bytes + at + 4, sizes[i]); put32(bytes + at + 8, types[i]);
    memcpy(bytes + at + 12, "CORE\0", 5); at += 20;
    if (!i) {
      put16(bytes + at + 12, SIGSEGV); put32(bytes + at + 32, 42); put32(bytes + at + 36, 1);
      put64(bytes + at + 112 + 16 * 8, 0x1a8c0d5);
    } else if (i == 2) {
      put32(bytes + at, SIGSEGV); put32(bytes + at + 8, 2); put64(bytes + at + 16, 0x12345000);
    }
    at += sizes[i];
  }
  memcpy(bytes + 4096, "unread heap tail", 16);
  return at;
}
int main(void)
{
  alarm(3);
  for (unsigned test = 0; test < 9; test++) {
    unsigned char bytes[8192]; size_t end = fixture(bytes), length = 4112;
    if (test == 1) length = 20;
    if (test == 2) put16(bytes + 56, 2049);
    if (test == 3) put64(bytes + 128, 192);
    if (test == 4) put16(bytes + 18, 183);
    if (test == 5) length = end - 1;
    if (test == 6) put32(bytes + 176 + 20 + 32, 43);
    if (test == 7) put32(bytes + end - 128 - 20 + 4, 127);
    int pipefd[2]; if (pipe(pipefd)) return 2;
    if (test != 8) {
      if (write(pipefd[1], bytes, length) != (ssize_t)length) return 3;
      close(pipefd[1]);
    }
    struct input input = {.fd = pipefd[0], .deadline = deadline(test == 8 ? 50 : 3000)}; struct notes notes = {0};
    bool valid = decode(&input, 42, SIGSEGV, &notes);
    if ((!test && (!valid || input.bytes != end || input.bytes >= 4096 || notes.address != 0x12345000 || notes.rip != 0x1a8c0d5)) ||
        (test && valid)) return 4;
    if (test == 8) {
      if (errno != ETIMEDOUT || input.bytes != 0) return 5;
      close(pipefd[1]);
    }
    close(pipefd[0]);
  }
  puts("OCTANT_CORE_PARSER valid prefix with unread memory, seven invalid inputs and stalled-input timeout passed");
  return 0;
}
#endif

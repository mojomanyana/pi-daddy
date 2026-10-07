/* Compile-time fault injection only. The shipped helper has no test hooks or alternate proc path. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static int fault_mode;
static ssize_t fault_read(int fd, void *buffer, size_t count);
static FILE *fault_fopen(const char *path, const char *mode);
#define read fault_read
#define fopen fault_fopen
#define main worker_main
#include "worker.c"
#undef read
#undef fopen
#undef main
static ssize_t fault_read(int fd, void *buffer, size_t count) {
  if (fault_mode == 1 && fd == 3) { errno = EBADF; return -1; }
  return read(fd, buffer, count);
}
static FILE *fault_fopen(const char *path, const char *mode) {
  if (fault_mode == 2 && strstr(path, "/children")) { errno = ENOENT; return NULL; }
  return fopen(path, mode);
}
int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (!strcmp(argv[1], "read-error")) fault_mode = 1;
  else if (!strcmp(argv[1], "missing-children")) fault_mode = 2;
  else return 64;
  return worker_main(argc - 1, argv + 1);
}

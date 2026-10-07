/* Synthetic runtime-effect control ONLY. No hashing, cache policy, installation or privilege. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void effect(void) {
    const char *path = getenv("CHECKSUM_FIXTURE_EFFECT");
    if (!path) return;
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) _exit(124);
    const char bytes[] = "fixture constructor effect\n";
    size_t done = 0;
    while (done < sizeof bytes - 1) {
        ssize_t n = write(fd, bytes + done, sizeof bytes - 1 - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) _exit(124);
        done += (size_t)n;
    }
    if (close(fd) != 0) _exit(124);
}

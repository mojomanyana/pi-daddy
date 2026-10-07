/* Own-process terminal-write fault; no filesystem/system mutation. Protects honest broker shutdown. */
#define main broker_main
#include "../src/executors/native/cache-broker.c"
#undef main
static ssize_t cookie_write(void *cookie, const char *bytes, size_t size) {
    (void)cookie;
    if (memmem(bytes, size, "CP1 CLOSED ", 11)) { errno=EIO; return -1; }
    return write(STDOUT_FILENO, bytes, size);
}
int main(int argc, char **argv) {
    FILE *stream=fopencookie(NULL,"w",(cookie_io_functions_t){.write=cookie_write});
    if(!stream)return 78;
    stdout=stream;
    int result=broker_main(argc,argv);
    (void)fflush(stdout); /* expose the old unchecked final write before normal process exit */
    return result;
}

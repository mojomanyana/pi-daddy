/* Controlled deterministic streams for live delivery tests; failure is never reusable. */
#include <string.h>
#include <unistd.h>
static int output(int fd,const char *data,size_t bytes) {
    while(bytes){ssize_t n=write(fd,data,bytes);if(n<=0)return -1;data+=n;bytes-=(size_t)n;}return 0;
}
int main(void) {
    char bytes[4096];
    if(output(1,"start\n",6))return 78;
    usleep(150000);
    memset(bytes,'a',sizeof bytes);for(int n=0;n<512;n++)if(output(1,bytes,sizeof bytes))return 78;
    memset(bytes,'b',sizeof bytes);for(int n=0;n<256;n++)if(output(2,bytes,sizeof bytes))return 78;
    return 7;
}

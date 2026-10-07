/* Inactive static Linux shellPath byte leaf. Node alone owns roles, grants, profiles and execution.
 * Private CF1 sidecar belongs to actual /proc/self/exe, never argv0 or command environment.
 * B/A then client G: coordinator MUST NOT execute/join/replay until G arrives. Set committed before
 * attempting G; never exec/retry after that attempt. Before it, transport uncertainty safely execs
 * selected original shell, same PID/argv/cwd/environ/descriptors. Socket is private/CLOEXEC.
 * Production composition/native-option authentication/packaging remain separate qualification gates.
 */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <poll.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <time.h>
#define REQUEST 1200000U
#define CHUNK 4096U
extern char **environ;
static char config[8193];
static int problem(const char *why) { fprintf(stderr,"cache shell: %s\n",why); return 78; }
static int64_t now(void) {
    struct timespec value;
    if(clock_gettime(CLOCK_MONOTONIC,&value))return -1;
    return (int64_t)value.tv_sec*1000+value.tv_nsec/1000000;
}
static int wait_io(int fd,short event,int64_t deadline) {
    for(;;) {
        int timeout=-1;
        if(deadline>=0) {int64_t clock=now();if(clock<0)return -1;int64_t left=deadline-clock;if(left<=0||left>30000)return -1;timeout=(int)left;}
        struct pollfd check={.fd=fd,.events=event};int result=poll(&check,1,timeout);
        if(result<0&&errno==EINTR)continue;
        if(result<=0||check.revents&(POLLERR|POLLNVAL))return -1;
        if(check.revents&(event|POLLHUP))return 0;
    }
}
static int exchange(int fd,void *buffer,size_t size,int sending,int64_t deadline) {
    unsigned char *bytes=buffer;size_t done=0;
    while(done<size) {
        if(deadline>=0&&(now()<0||now()>=deadline))return -1;
        ssize_t count=sending?send(fd,bytes+done,size-done,MSG_NOSIGNAL):recv(fd,bytes+done,size-done,0);
        if(count>0){done+=(size_t)count;continue;}
        if(count==0)return -1;
        if(errno==EINTR)continue;
        if(errno!=EAGAIN&&errno!=EWOULDBLOCK)return -1;
        if(wait_io(fd,sending?POLLOUT:POLLIN,deadline))return -1;
    }
    return 0;
}
static int output(int fd,const unsigned char *bytes,size_t size) {
    size_t done=0;
    while(done<size) {
        ssize_t count=write(fd,bytes+done,size-done);
        if(count>0){done+=(size_t)count;continue;}
        if(count<0&&errno==EINTR)continue;
        if(count<0&&(errno==EAGAIN||errno==EWOULDBLOCK)&&!wait_io(fd,POLLOUT,-1))continue;
        return -1;
    }
    return 0;
}
static int settings(char **shell,char **socket_path,int *milliseconds) {
    char path[PATH_MAX+16];ssize_t size=readlink("/proc/self/exe",path,PATH_MAX);
    if(size<=0||size>=PATH_MAX)return -1;
    path[size]=0;strcat(path,".config");
    char directory[PATH_MAX+16];strcpy(directory,path);char *slash=strrchr(directory,'/');if(!slash)return -1;*slash=0;
    int parent=open(directory,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(parent<0)return -1;
    struct stat dir;int valid=!fstat(parent,&dir)&&dir.st_uid==getuid()&&!(dir.st_mode&077);
    if(!valid){close(parent);return -1;}
    int fd=openat(parent,slash+1,O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
    if(close(parent)){if(fd>=0)close(fd);return -1;}
    if(fd<0)return -1;
    struct stat info;
    valid=!fstat(fd,&info)&&S_ISREG(info.st_mode)&&info.st_uid==getuid()&&!(info.st_mode&077)&&info.st_nlink==1&&info.st_size>0&&info.st_size<=8192;
    size_t used=0;
    if(valid)for(;;) {
        ssize_t count=read(fd,config+used,sizeof(config)-1-used);
        if(count<0&&errno==EINTR)continue;
        if(count<0){valid=0;break;}
        if(!count)break;
        used+=(size_t)count;if(used>=sizeof(config)-1){valid=0;break;}
    }
    if(close(fd))valid=0;
    if(!valid||used!=(size_t)info.st_size||memchr(config,0,used))return -1;
    config[used]=0;char *lines[4],*cursor=config;
    for(int i=0;i<4;i++){lines[i]=cursor;char *end=strchr(cursor,'\n');if(!end)return -1;*end=0;cursor=end+1;}
    if(*cursor||strcmp(lines[0],"CF1")||lines[1][0]!='/'||lines[2][0]!='/'||strlen(lines[1])>=PATH_MAX||strlen(lines[2])>=sizeof(((struct sockaddr_un*)0)->sun_path))return -1;
    if(!*lines[3]||lines[3][0]=='0')return -1;
    unsigned int timeout=0;
    for(char *p=lines[3];*p;p++){if(*p<'0'||*p>'9'||timeout>3000)return -1;timeout=timeout*10+(unsigned int)(*p-'0');}
    if(!timeout||timeout>30000)return -1;
    struct stat self,target;
    if(stat("/proc/self/exe",&self)||stat(lines[1],&target)||!S_ISREG(target.st_mode)||(self.st_dev==target.st_dev&&self.st_ino==target.st_ino))return -1;
    *shell=lines[1];*socket_path=lines[2];*milliseconds=(int)timeout;return 0;
}
static int original(char *shell,char **argv,int fd) {
    if(fd>=0&&close(fd))return problem("pre-commit socket close failed; original execution not attempted");
    argv[0]=shell;execve(shell,argv,environ);
    fprintf(stderr,"cache shell: original shell exec failed (errno %d)\n",errno);return 127;
}
static void integer(unsigned char **out,uint32_t value) {value=htonl(value);memcpy(*out,&value,4);*out+=4;}
static void string(unsigned char **out,const char *value) {size_t size=strlen(value);integer(out,(uint32_t)size);memcpy(*out,value,size);*out+=size;}
static unsigned char *request(char *shell,int argc,char **argv,size_t *size) {
    if(argc!=3||strcmp(argv[1],"-c")||strlen(argv[2])>65536)return NULL;
    char cwd[PATH_MAX];if(!getcwd(cwd,sizeof(cwd)))return NULL;
    size_t count=0,env_size=0;
    for(char **entry=environ;*entry;entry++) {
        size_t bytes=strlen(*entry)+4;
        if(count>=4096||bytes>1048576-env_size)return NULL;
        env_size+=bytes;count++;
    }
    size_t body=4+strlen(shell)+4+strlen(cwd)+4+4+strlen(argv[1])+4+strlen(argv[2])+4+env_size;
    if(body>REQUEST)return NULL;
    unsigned char *packet=malloc(body+8);if(!packet)return NULL;
    memcpy(packet,"CS1\0",4);unsigned char *out=packet+4;integer(&out,(uint32_t)body);
    string(&out,shell);string(&out,cwd);integer(&out,2);string(&out,argv[1]);string(&out,argv[2]);integer(&out,(uint32_t)count);
    for(char **entry=environ;*entry;entry++)string(&out,*entry);
    *size=body+8;return packet;
}
static int connect_to(const char *path,int64_t deadline) {
    int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);if(fd<0)return -1;
    /* Preserve closed stdin/stdout/stderr; never turn an application stream into the cache socket. */
    if(fd<3) {
        int copy=fcntl(fd,F_DUPFD_CLOEXEC,3);
        if(close(fd)){if(copy>=0)close(copy);return -1;}
        fd=copy;if(fd<0)return -1;
    }
    struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,path);
    if(connect(fd,(struct sockaddr*)&address,sizeof(address))) {
        if(errno!=EINPROGRESS&&errno!=EAGAIN){close(fd);return -1;}
        if(wait_io(fd,POLLOUT,deadline)){close(fd);return -1;}
        int error=0;socklen_t length=sizeof(error);
        if(getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&length)||length!=sizeof(error)||error){close(fd);return -1;}
    }
    return fd;
}
static int terminal_signal(uint32_t value) {
    switch(value) {case 1:case 2:case 3:case 4:case 5:case 6:case 7:case 8:case 9:case 11:case 13:case 14:case 15:case 24:case 25:case 26:case 27:case 31:return 1;default:return 0;}
}
static int committed(int fd) {
    unsigned char header[5],bytes[CHUNK];
    for(;;) {
        if(exchange(fd,header,sizeof(header),0,-1))return problem("committed transport lost; execution uncertain; not rerunning");
        uint32_t value;memcpy(&value,header+1,4);value=ntohl(value);
        if(header[0]=='O'||header[0]=='E') {
            if(!value||value>CHUNK)return problem("committed output invalid; execution uncertain; not rerunning");
            if(exchange(fd,bytes,value,0,-1)||output(header[0]=='O'?STDOUT_FILENO:STDERR_FILENO,bytes,value))
                return problem("committed output lost; execution uncertain; not rerunning");
            continue;
        }
        if(header[0]=='X'&&value<=255){if(close(fd))return problem("committed socket close failed; execution uncertain");return (int)value;}
        if(header[0]=='S'&&terminal_signal(value)) {
            if(close(fd))return problem("committed socket close failed; execution uncertain");
            struct sigaction action={.sa_handler=SIG_DFL};sigemptyset(&action.sa_mask);
            sigset_t mask;sigemptyset(&mask);sigaddset(&mask,(int)value);
            /* SIGKILL has no configurable disposition; attempting sigaction on it always fails. */
            if((value!=SIGKILL&&sigaction((int)value,&action,NULL))||sigprocmask(SIG_UNBLOCK,&mask,NULL)||raise((int)value))
                return problem("committed signal invalid; execution uncertain; not rerunning");
            return problem("committed signal did not terminate; execution uncertain; not rerunning");
        }
        return problem("committed response invalid; execution uncertain; not rerunning");
    }
}
int main(int argc,char **argv) {
    char *shell=NULL,*socket_path=NULL;int milliseconds=0;
    if(settings(&shell,&socket_path,&milliseconds))return problem("private CF1 configuration unavailable, unsafe or malformed");
    size_t size=0;unsigned char *packet=request(shell,argc,argv,&size);
    if(!packet)return original(shell,argv,-1);
    int64_t clock=now();if(clock<0){free(packet);return original(shell,argv,-1);}
    int64_t deadline=clock+milliseconds;int fd=connect_to(socket_path,deadline);
    if(fd<0){free(packet);return original(shell,argv,-1);}
    int failed=exchange(fd,packet,size,1,deadline);free(packet);
    unsigned char offer=0;
    if(failed||exchange(fd,&offer,1,0,deadline))return original(shell,argv,fd);
    if(offer=='R') {
        if(close(fd))return problem("refused socket close failed; original execution not attempted");
        fputs("cache shell: coordinator rejected invocation; original execution not attempted\n",stderr);return 126;
    }
    if(offer!='A')return original(shell,argv,fd);
    /* Commitment begins BEFORE the send attempt: even a failed send cannot prove nonreceipt. */
    unsigned char go='G';
    if(exchange(fd,&go,1,1,-1))return problem("committed send lost; execution uncertain; not rerunning");
    return committed(fd);
}

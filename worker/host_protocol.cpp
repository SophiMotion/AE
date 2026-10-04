// POSIX harness for the SAME protocol core. This is not ESP32 chip execution.
#include "protocol_core.hpp"
#if __has_include("model_binding.hpp")
#include "model_binding.hpp"
#endif
#include <poll.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string>

static uint32_t now_ms() {
  timespec now;clock_gettime(CLOCK_MONOTONIC,&now);
  return uint32_t(uint64_t(now.tv_sec)*1000+now.tv_nsec/1000000);
}
static void emit(void* context,const char* text) {
  int fd=*static_cast<int*>(context);
  std::string line=std::string(text)+"\n";
  size_t done=0;
  while(done<line.size()) {
    ssize_t count=write(fd,line.data()+done,line.size()-done);
    if(count>0) done+=size_t(count);
    else if(errno==EINTR) continue;
    else break;
  }
}
int main(int argc,char** argv) {
  if(argc!=5) return 2;
  int fd=atoi(argv[1]);
  ae::ProtocolCore core(strcmp(argv[2],"joint_position")==0,atof(argv[3]),atof(argv[4]),emit,&fd
#ifdef AE_PROTOCOL_V3
    ,ae_model_binding
#endif
  );
  fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK);
  for(;;) {
    pollfd descriptor{fd,POLLIN,0};
    int ready=poll(&descriptor,1,5);
    if(ready<0 && errno!=EINTR) return 3;
    if(ready>0 && descriptor.revents&POLLIN) {
      char buffer[512];ssize_t count=read(fd,buffer,sizeof(buffer));
      if(count==0) return 0;
      if(count>0) for(ssize_t i=0;i<count;i++) core.feed(buffer[i],now_ms());
    }
    core.tick(now_ms());
  }
}

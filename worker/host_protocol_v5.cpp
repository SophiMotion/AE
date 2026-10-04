// Host executes exactly the firmware header; not an ESP32 emulator.
#include "protocol_core_v5.hpp"
#include "model_binding_v5.hpp"
#include <poll.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>
#include <string>
static uint32_t now_ms() {timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return uint32_t(uint64_t(t.tv_sec)*1000+t.tv_nsec/1000000);}
struct Output {int fd;std::string pending;};
static void emit(void* context,const char* text) {
  Output& output=*static_cast<Output*>(context);
  output.pending+=std::string(text)+"\n";
  if(output.pending.size()>32768) exit(4); // Failure stops the writer; downstream lease expires.
}
static bool flush(Output& output) {
  while(!output.pending.empty()) {
    ssize_t n=write(output.fd,output.pending.data(),output.pending.size());
    if(n>0) output.pending.erase(0,size_t(n));
    else if(errno==EINTR) continue;
    else if(errno==EAGAIN || errno==EWOULDBLOCK) return true;
    else return false;
  }
  return true;
}
int main(int argc,char** argv) {
  if(argc!=2) return 2;
  int fd=atoi(argv[1]);Output output{fd,{}};ae5::ProtocolCore core(ae5_model_binding,emit,&output);fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK);
  for(;;) {
    pollfd p{fd,POLLIN,0};int ready=poll(&p,1,2);if(ready<0&&errno!=EINTR) return 3;
    if(ready>0&&(p.revents&POLLIN)) {char buffer[4096];ssize_t n=read(fd,buffer,sizeof(buffer));if(n==0) return 0;if(n>0) for(ssize_t i=0;i<n;++i) core.feed(buffer[i],now_ms());}
    core.tick(now_ms());
    if(!flush(output)) return 5;
  }
}

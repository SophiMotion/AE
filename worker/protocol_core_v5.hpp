#pragma once
// Identical source for native PTY bench and ESP32 targets; no physical IO.
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
namespace ae5 {
static constexpr unsigned MAX_JOINTS=16;
static constexpr unsigned LINE_BYTES=2048;
typedef void (*Emit)(void*,const char*);
struct Binding {
  const char* model_sha256; const char* program_sha256; const char* protocol_sha256;
  unsigned count; const char* names[MAX_JOINTS]; double initial[MAX_JOINTS];
  double lower[MAX_JOINTS]; double upper[MAX_JOINTS]; double vmax; double amax; double tolerance;
};
class ProtocolCore {
 public:
  ProtocolCore(const Binding& binding,Emit emitter,void* context):b_(binding),emit_(emitter),context_(context) {
    for(unsigned i=0;i<b_.count;++i) measured_[i]=target_[i]=b_.initial[i];
  }
  void feed(char byte,uint32_t now) {
    if(byte=='\n') {
      if(overflow_) event("protocol_error","oversize_or_nul");
      else if(used_) {line_[used_]=0;receive(now);}
      used_=0;overflow_=false;return;
    }
    if(byte==0 || used_>=sizeof(line_)-1) {overflow_=true;return;}
    if(!overflow_) line_[used_++]=byte;
  }
  void tick(uint32_t now) {
    expire(now);
    if(!started_) {started_=true;last_tick_=last_publish_=now;return;}
    last_tick_=now;
    // Servo acceleration belongs to the simulation clock. A repeated stamp
    // cannot cause motion to ramp while Gazebo is paused or slower than wall time.
    if(has_measurement_ && measurement_seq_!=servo_measurement_seq_) {
      const double dt=servo_stamp_<0?0:fmin(measurement_stamp_-servo_stamp_,0.1);
      servo_stamp_=measurement_stamp_;servo_measurement_seq_=measurement_seq_;
      if(has_command_) {
      for(unsigned i=0;i<b_.count;++i) {
        double desired=fmax(-b_.vmax,fmin(b_.vmax,4.0*(target_[i]-measured_[i])));
        if((measured_[i]<=b_.lower[i] && desired<0)||(measured_[i]>=b_.upper[i] && desired>0)) desired=0;
        velocities_[i]+=fmax(-b_.amax*dt,fmin(b_.amax*dt,desired-velocities_[i]));
        // A limit is a hard guard, taking priority over smooth deceleration.
        if((measured_[i]<=b_.lower[i] && velocities_[i]<0)||(measured_[i]>=b_.upper[i] && velocities_[i]>0)) velocities_[i]=0;
      }
      }
    }
    if(!has_command_ || !has_measurement_) zero();
    if(bound_ && uint32_t(now-last_publish_)>=20) {last_publish_=now;publish();}
  }
  double applied(unsigned i) const {return velocities_[i];}
  int64_t last_sequence() const {return command_seq_;}
 private:
  struct Packet {
    char kind[20]={0},session[33]={0},model[65]={0},program[65]={0},protocol[65]={0};
    char names[MAX_JOINTS][100]={}; double positions[MAX_JOINTS]={};
    unsigned names_n=0,positions_n=0,seen=0; double seq=0,stamp=0,version=0;
  };
  static void ws(const char*& p) {while(*p==' '||*p=='\t'||*p=='\r') ++p;}
  static bool text(const char*& p,char* dest,size_t capacity) {
    if(*p++!='"') return false;
    size_t n=0;
    while(*p && *p!='"') {if(n+1>=capacity || *p=='\\' || static_cast<unsigned char>(*p)<32) return false;dest[n++]=*p++;}
    if(*p!='"') return false;
    ++p;dest[n]=0;return true;
  }
  static bool number(const char*& p,double& value,bool integer=false) {
    const char* begin=p;if(*p=='-') ++p;
    if(*p=='0') {++p;if(*p>='0'&&*p<='9') return false;}
    else {if(*p<'1'||*p>'9') return false;while(*p>='0'&&*p<='9') ++p;}
    if(*p=='.') {if(integer) return false;++p;if(*p<'0'||*p>'9') return false;while(*p>='0'&&*p<='9') ++p;}
    if(*p=='e'||*p=='E') {if(integer) return false;++p;if(*p=='+'||*p=='-') ++p;if(*p<'0'||*p>'9') return false;while(*p>='0'&&*p<='9') ++p;}
    char* end=nullptr;value=strtod(begin,&end);return end==p && isfinite(value);
  }
  bool parse(Packet& packet) {
    const char* p=line_;ws(p);if(*p!='{') return false;++p;
    for(unsigned fields=0;fields<9;++fields) {
      char key[32];ws(p);if(!text(p,key,sizeof(key))) return false;ws(p);if(*p!=':') return false;++p;ws(p);
      unsigned bit=0;char* dest=nullptr;size_t cap=0;double* numeric=nullptr;
      if(!strcmp(key,"kind")) {bit=1;dest=packet.kind;cap=sizeof(packet.kind);}
      else if(!strcmp(key,"session")) {bit=2;dest=packet.session;cap=sizeof(packet.session);}
      else if(!strcmp(key,"seq")) {bit=4;numeric=&packet.seq;}
      else if(!strcmp(key,"time")) {bit=8;numeric=&packet.stamp;}
      else if(!strcmp(key,"positions")) bit=16;
      else if(!strcmp(key,"protocol_version")) {bit=32;numeric=&packet.version;}
      else if(!strcmp(key,"model_sha256")) {bit=64;dest=packet.model;cap=sizeof(packet.model);}
      else if(!strcmp(key,"program_sha256")) {bit=128;dest=packet.program;cap=sizeof(packet.program);}
      else if(!strcmp(key,"protocol_sha256")) {bit=256;dest=packet.protocol;cap=sizeof(packet.protocol);}
      else if(!strcmp(key,"joint_names")) bit=512;
      else return false;
      if(packet.seen&bit) return false;
      if(dest) {if(!text(p,dest,cap)) return false;}
      else if(numeric) {if(!number(p,*numeric,bit==4||bit==32)) return false;}
      else {
        if(*p!='[') return false;
        ++p;ws(p);unsigned n=0;
        while(*p!=']') {
          if(n>=MAX_JOINTS) return false;
          if(bit==16) {if(!number(p,packet.positions[n])) return false;}
          else if(!text(p,packet.names[n],sizeof(packet.names[n]))) return false;
          ++n;ws(p);if(*p==']') break;if(*p!=',') return false;++p;ws(p);if(*p==']') return false;
        }
        ++p;if(bit==16) packet.positions_n=n;else packet.names_n=n;
      }
      packet.seen|=bit;ws(p);if(*p=='}') {++p;ws(p);return !*p;}
      if(*p!=',') return false;
      ++p;
    }
    return false;
  }
  static bool session_valid(const char* session) {
    if(strlen(session)!=32) return false;
    for(unsigned i=0;i<32;++i) if(!((session[i]>='0'&&session[i]<='9')||(session[i]>='a'&&session[i]<='f'))) return false;
    return true;
  }
  void receive(uint32_t now) {
    expire(now);Packet p;
    if(!parse(p)||!session_valid(p.session)) {event("protocol_error","format");return;}
    if(!strcmp(p.kind,"hello")) {
      if(p.seen!=(1|2|32|64|128|256|512)||p.version!=5 ||strcmp(p.model,b_.model_sha256)||strcmp(p.program,b_.program_sha256)||strcmp(p.protocol,b_.protocol_sha256)||p.names_n!=b_.count) {event("protocol_error","identity");return;}
      for(unsigned i=0;i<b_.count;++i) if(strcmp(p.names[i],b_.names[i])) {event("protocol_error","joint_order");return;}
      if(bound_ && strcmp(session_,p.session)) {event("protocol_error","session_rebind");return;}
      strcpy(session_,p.session);bound_=true;event("hello_ack","");return;
    }
    if(!bound_||strcmp(p.session,session_)) {event("protocol_error","session");return;}
    if(p.seen!=(1|2|4|8|16)||p.seq<0||p.seq>2147483647||p.stamp<0||p.positions_n!=b_.count) {event("protocol_error","vector_format");return;}
    const bool measurement=!strcmp(p.kind,"measurement");
    if(!measurement && strcmp(p.kind,"command")) {event("protocol_error","kind");return;}
    for(unsigned i=0;i<b_.count;++i) if(p.positions[i]<b_.lower[i]||p.positions[i]>b_.upper[i]) {event("protocol_error",measurement?"measurement_range":"command_range");return;}
    const int64_t seq=int64_t(p.seq);
    if(seq<=(measurement?measurement_seq_:command_seq_) || p.stamp<(measurement?measurement_stamp_:command_stamp_)) {event("protocol_error","replay_or_time");return;}
    // All checks finish before any member of the vector or lease is changed.
    if(measurement) {
      for(unsigned i=0;i<b_.count;++i) measured_[i]=p.positions[i];
      measurement_seq_=seq;measurement_stamp_=p.stamp;last_measurement_=now;has_measurement_=true;
    } else {
      if(!has_measurement_) {event("protocol_error","no_fresh_measurement");return;}
      if(fabs(p.stamp-measurement_stamp_)>1.0) {event("protocol_error","command_time_window");return;}
      for(unsigned i=0;i<b_.count;++i) target_[i]=p.positions[i];
      command_seq_=seq;command_stamp_=p.stamp;last_command_=now;has_command_=true;event("command_applied","");
    }
  }
  void zero() {for(unsigned i=0;i<b_.count;++i) velocities_[i]=0;}
  void expire(uint32_t now) {
    if(has_command_ && uint32_t(now-last_command_)>600) {has_command_=false;zero();event("command_timeout","");}
    if(has_measurement_ && uint32_t(now-last_measurement_)>600) {has_measurement_=false;has_command_=false;zero();event("measurement_timeout","");}
  }
  void event(const char* name,const char* reason) {
    char output[256];snprintf(output,sizeof(output),"{\"kind\":\"event\",\"event\":\"%s\",\"reason\":\"%s\",\"session\":\"%s\",\"applied_seq\":%lld}",name,reason,session_,static_cast<long long>(command_seq_));emit_(context_,output);
  }
  void publish() {
    char output[LINE_BYTES];size_t n=0;
    auto add=[&](const char* format,auto... args) {if(n>=sizeof(output)) return;int count=snprintf(output+n,sizeof(output)-n,format,args...);if(count<0) n=sizeof(output);else n+=size_t(count);};
    add("{\"kind\":\"state\",\"session\":\"%s\",\"seq\":%lu,\"time\":%.17g,\"measurement_seq\":%lld,\"applied_seq\":%lld,\"command_fresh\":%s,\"measurement_fresh\":%s,\"active\":%s",session_,static_cast<unsigned long>(state_seq_++),fmax(0.0,measurement_stamp_),static_cast<long long>(measurement_seq_),static_cast<long long>(command_seq_),has_command_?"true":"false",has_measurement_?"true":"false",(has_command_&&has_measurement_)?"true":"false");
    const char* names[]={"positions","target_positions","velocities"};const double* values[]={measured_,target_,velocities_};
    for(unsigned k=0;k<3;++k) {add(",\"%s\":[",names[k]);for(unsigned i=0;i<b_.count;++i) add(i?",%.17g":"%.17g",values[k][i]);add("%s","]");}
    add("%s","}");if(n<sizeof(output)) emit_(context_,output);else {zero();has_command_=false;event("protocol_error","output_overflow");}
  }
  Binding b_;Emit emit_;void* context_;char line_[LINE_BYTES],session_[33]={};size_t used_=0;
  bool overflow_=false,bound_=false,started_=false,has_command_=false,has_measurement_=false;
  double measured_[MAX_JOINTS]={},target_[MAX_JOINTS]={},velocities_[MAX_JOINTS]={};
  double measurement_stamp_=-1,command_stamp_=-1,servo_stamp_=-1;int64_t measurement_seq_=-1,command_seq_=-1,servo_measurement_seq_=-1;
  uint32_t last_tick_=0,last_publish_=0,last_measurement_=0,last_command_=0,state_seq_=0;
};
}

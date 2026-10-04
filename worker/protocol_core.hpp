#pragma once
// Shared native/ESP32 bench protocol. No GPIO or physical actuator operations.
#include <ArduinoJson.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>

namespace ae {
typedef void (*Emit)(void*,const char*);
class ProtocolCore {
 public:
  ProtocolCore(bool joint,double threshold,double limit,Emit emitter,void* context)
      :joint_(joint),threshold_(threshold),limit_(limit),emit_(emitter),context_(context) {}
  void feed(char byte,uint32_t now) {
    if(byte=='\n') {
      if(overflow_) event("protocol_error","oversize_or_nul");
      else if(used_) { line_[used_]=0; receive(now); }
      used_=0; overflow_=false; return;
    }
    if(byte==0 || used_>=sizeof(line_)-1) {overflow_=true;return;}
    if(!overflow_) line_[used_++]=byte;
  }
  void tick(uint32_t now) {
    if(!started_) {started_=true;last_tick_=now;last_publish_=now;}
    const uint32_t delta=now-last_tick_;
    elapsed_+=delta;
    last_tick_=now;
    if(has_command_ && uint32_t(now-last_command_)>600) {
      applied_=0;has_command_=false;event("device_timeout","");
    }
    if(joint_) {
      const double dt=fmin(double(delta)/1000.0,0.1);
      measured_=fmax(-3.0,fmin(3.0,measured_+applied_*dt));
    }
    if(uint32_t(now-last_publish_)>=50) {
      last_publish_=now;
      if(!joint_) {
        double pattern[]={0,fmax(0.0,threshold_-0.05),threshold_,fmin(1.0,threshold_+0.05),1,0};
        measured_=pattern[(state_seq_/5)%6];
      }
      JsonDocument packet;
      packet["kind"]="state"; packet["seq"]=state_seq_++;
      packet["time"]=double(elapsed_)/1000.0;packet["value"]=measured_;
      packet["applied"]=applied_;packet["applied_seq"]=last_seq_;
      send(packet);
    }
  }
  double applied() const {return applied_;}
  int64_t last_sequence() const {return last_seq_;}
 private:
  static void whitespace(const char*& p) {while(*p==' ' || *p=='\t' || *p=='\r') ++p;}
  static bool number(const char*& p,double& value,bool integer) {
    const char* begin=p;
    if(*p=='-') ++p;
    if(*p=='0') {++p;if(*p>='0' && *p<='9') return false;}
    else {if(*p<'1' || *p>'9') return false;while(*p>='0' && *p<='9') ++p;}
    if(*p=='.') {if(integer) return false;++p;if(*p<'0' || *p>'9') return false;while(*p>='0' && *p<='9') ++p;}
    if(*p=='e' || *p=='E') {if(integer) return false;++p;if(*p=='+' || *p=='-') ++p;if(*p<'0' || *p>'9') return false;while(*p>='0' && *p<='9') ++p;}
    char* end=nullptr;value=strtod(begin,&end);
    return end==p && isfinite(value);
  }
  bool command(double& sequence,double& stamp,double& value) {
    // Fixed flat numeric schema. Check every byte; reject duplicate/unknown
    // keys and trailing content. strtod preserves double boundary values,
    // unlike ArduinoJson's small-mantissa float32 input optimization.
    const char* p=line_;unsigned seen=0;
    whitespace(p);if(*p++!='{') return false;
    for(unsigned field=0;field<3;++field) {
      whitespace(p);if(*p++!='"') return false;
      char key[6];unsigned length=0;
      while(*p && *p!='"') {if(length>=5 || *p=='\\') return false;key[length++]=*p++;}
      key[length]=0;if(*p++!='"') return false;
      whitespace(p);if(*p++!=':') return false;whitespace(p);
      unsigned bit;double* destination;
      if(strcmp(key,"seq")==0) {bit=1;destination=&sequence;}
      else if(strcmp(key,"time")==0) {bit=2;destination=&stamp;}
      else if(strcmp(key,"value")==0) {bit=4;destination=&value;}
      else return false;
      if(seen&bit || !number(p,*destination,bit==1)) return false;
      seen|=bit;whitespace(p);
      if(field<2) {if(*p++!=',') return false;}
      else if(*p++!='}') return false;
    }
    whitespace(p);return seen==7 && *p==0;
  }
  void receive(uint32_t now) {
    double sequence=0,value=0,stamp=0;
    if(!command(sequence,stamp,value)) {
      event("protocol_error","format"); return;
    }
    if(sequence<0 || sequence>2147483647 || stamp<0) {event("protocol_error","nonfinite_or_sequence");return;}
    int64_t seq=int64_t(sequence);
    if((joint_ && fabs(value)>limit_+1e-9) || (!joint_ && value!=0.0 && value!=1.0)) {event("protocol_error","range");return;}
    if(seq<=last_seq_) {event("command_duplicate","");return;}
    last_seq_=seq;applied_=value;last_command_=now;has_command_=true;
    event("command_applied","");
  }
  void event(const char* name,const char* reason) {
    JsonDocument packet;
    packet["kind"]="event";packet["event"]=name;packet["reason"]=reason;
    packet["seq"]=last_seq_;packet["time"]=double(elapsed_)/1000.0;packet["value"]=applied_;
    send(packet);
  }
  void send(const JsonDocument& packet) {
    char buffer[512];
    if(measureJson(packet)>=sizeof(buffer)) return;
    serializeJson(packet,buffer,sizeof(buffer));emit_(context_,buffer);
  }
  bool joint_,started_=false,has_command_=false,overflow_=false;
  double threshold_,limit_,applied_=0,measured_=0;
  Emit emit_; void* context_;
  char line_[512];size_t used_=0;
  int64_t last_seq_=-1;
  uint32_t state_seq_=0,last_tick_=0,last_publish_=0,last_command_=0;
  uint64_t elapsed_=0;
};
}

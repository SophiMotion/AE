#pragma once
// Trusted measurement bench: shared ESP32/native source; no physical IO.
#include <ArduinoJson.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "device_logic.hpp"
namespace ae {
typedef void (*Emit)(void*,const char*);
struct Binding {const char* joint_name;const char* model_sha256;const char* protocol_sha256;double lower;double upper;bool external_measurement;};
class ProtocolCore {
 public:
  ProtocolCore(bool joint,double threshold,double limit,Emit emitter,void* context,const Binding& binding)
   :joint_(joint),threshold_(threshold),limit_(limit),emit_(emitter),context_(context),binding_(binding) {}
  void feed(char byte,uint32_t now) {
    if(byte=='\n') {if(overflow_) event("protocol_error","oversize_or_nul");else if(used_) {line_[used_]=0;receive(now);}used_=0;overflow_=false;return;}
    if(byte==0 || used_>=sizeof(line_)-1) {overflow_=true;return;}
    if(!overflow_) line_[used_++]=byte;
  }
  void tick(uint32_t now) {
    if(!started_) {started_=true;last_tick_=now;last_publish_=now;}
    elapsed_+=uint32_t(now-last_tick_);last_tick_=now;
    if(has_command_ && uint32_t(now-last_command_)>600) {applied_=0;has_command_=false;event("device_timeout","");}
    if(binding_.external_measurement) {
      if(has_measurement_ && uint32_t(now-last_measurement_)>600) {has_measurement_=false;applied_=0;has_command_=false;event("measurement_timeout","");}
      return; // Never integrate joint position: only Gazebo measurements create state.
    }
    if(uint32_t(now-last_publish_)>=50) {
      last_publish_=now;
      double pattern[]={0,fmax(0.0,threshold_-0.05),threshold_,fmin(1.0,threshold_+0.05),1,0};
      measured_=pattern[(state_seq_/5)%6];publish(state_seq_++,double(elapsed_)/1000.0);
    }
  }
  double applied() const {return applied_;}
  int64_t last_sequence() const {return last_seq_;}
 private:
  static void ws(const char*& p) {while(*p==' ' || *p=='\t' || *p=='\r') ++p;}
  static bool text(const char*& p,char* dest,size_t capacity) {
    if(*p!='"') return false;
    ++p;size_t n=0;
    while(*p && *p!='"') {if(n+1>=capacity || *p=='\\' || static_cast<unsigned char>(*p)<32) return false;dest[n++]=*p++;}
    if(*p!='"') return false;
    ++p;dest[n]=0;return true;
  }
  static bool number(const char*& p,double& value,bool integer) {
    const char* begin=p;if(*p=='-') ++p;
    if(*p=='0') {++p;if(*p>='0' && *p<='9') return false;}
    else {if(*p<'1'||*p>'9') return false;while(*p>='0'&&*p<='9') ++p;}
    if(*p=='.') {if(integer) return false;++p;if(*p<'0'||*p>'9') return false;while(*p>='0'&&*p<='9') ++p;}
    if(*p=='e'||*p=='E') {if(integer) return false;++p;if(*p=='+'||*p=='-') ++p;if(*p<'0'||*p>'9') return false;while(*p>='0'&&*p<='9') ++p;}
    char* end=nullptr;value=strtod(begin,&end);return end==p && isfinite(value);
  }
  bool parse(double& seq,double& stamp,double& value,char* kind) {
    const char* p=line_;unsigned seen=0;ws(p);if(*p!='{') return false;++p;
    for(unsigned n=0;n<7;++n) {
      char key[32],string_value[101];ws(p);if(!text(p,key,sizeof(key))) return false;ws(p);if(*p!=':') return false;++p;ws(p);
      unsigned bit=0;double* destination=nullptr;const char* expected=nullptr;
      if(!strcmp(key,"seq")) {bit=1;destination=&seq;}
      else if(!strcmp(key,"time")) {bit=2;destination=&stamp;}
      else if(!strcmp(key,"value")) {bit=4;destination=&value;}
      else if(!strcmp(key,"kind")) bit=8;
      else if(!strcmp(key,"joint_name")) {bit=16;expected=binding_.joint_name;}
      else if(!strcmp(key,"model_sha256")) {bit=32;expected=binding_.model_sha256;}
      else if(!strcmp(key,"protocol_sha256")) {bit=64;expected=binding_.protocol_sha256;}
      else return false;
      if(seen&bit) return false;
      if(destination) {if(!number(p,*destination,bit==1)) return false;}
      else {if(!text(p,string_value,sizeof(string_value))) return false;if(bit==8) {if(strlen(string_value)>15) return false;strcpy(kind,string_value);}else if(strcmp(string_value,expected)) return false;}
      seen|=bit;ws(p);if(n<6) {if(*p!=',') return false;}else if(*p!='}') return false;++p;
    }
    ws(p);return seen==127 && !*p;
  }
  void receive(uint32_t now) {
    double seq=0,stamp=0,value=0;char kind[16]={0};
    if(!parse(seq,stamp,value,kind) || seq<0 || seq>2147483647 || stamp<0) {event("protocol_error","format_or_identity");return;}
    const int64_t sequence=int64_t(seq);
    if(!strcmp(kind,"measurement")) {
      if(!binding_.external_measurement || value<binding_.lower-1e-6 || value>binding_.upper+1e-6) {event("protocol_error","measurement_range");return;}
      if(sequence<=measurement_seq_ || stamp<measurement_stamp_) {event("measurement_duplicate","");return;}
      measurement_seq_=sequence;measurement_stamp_=stamp;measured_=value;last_measurement_=now;has_measurement_=true;publish(uint32_t(sequence),stamp);return;
    }
    if(strcmp(kind,"command")) {event("protocol_error","kind");return;}
    if((joint_ && fabs(value)>limit_+1e-9) || (!joint_ && value!=0 && value!=1)) {event("protocol_error","command_range");return;}
    if(sequence<=last_seq_) {event("command_duplicate","");return;}
    if(binding_.external_measurement && !has_measurement_ && value!=0) {event("protocol_error","no_fresh_measurement");return;}
    const double limited=limit_command(value,joint_?limit_:1.0);
    if(!isfinite(limited) || fabs(limited)>(joint_?limit_:1.0)+1e-9 || (!joint_ && limited!=0 && limited!=1)) {applied_=0;event("device_logic_error","unsafe_output");return;}
    last_seq_=sequence;applied_=limited;last_command_=now;has_command_=true;event("command_applied","");
  }
  void publish(uint32_t seq,double stamp) {
    char buffer[512];const int count=snprintf(buffer,sizeof(buffer),"{\"kind\":\"state\",\"seq\":%lu,\"time\":%.17g,\"value\":%.17g,\"applied\":%.17g,\"applied_seq\":%lld,\"joint_name\":\"%s\",\"model_sha256\":\"%s\",\"protocol_sha256\":\"%s\"}",static_cast<unsigned long>(seq),stamp,measured_,applied_,static_cast<long long>(last_seq_),binding_.joint_name,binding_.model_sha256,binding_.protocol_sha256);
    if(count>0 && size_t(count)<sizeof(buffer)) emit_(context_,buffer);
  }
  void event(const char* name,const char* reason) {
    char buffer[512];const int count=snprintf(buffer,sizeof(buffer),"{\"kind\":\"event\",\"event\":\"%s\",\"reason\":\"%s\",\"seq\":%lld,\"time\":%.17g,\"value\":%.17g,\"joint_name\":\"%s\",\"model_sha256\":\"%s\",\"protocol_sha256\":\"%s\"}",name,reason,static_cast<long long>(last_seq_),double(elapsed_)/1000.0,applied_,binding_.joint_name,binding_.model_sha256,binding_.protocol_sha256);
    if(count>0 && size_t(count)<sizeof(buffer)) emit_(context_,buffer);
  }
  bool joint_,started_=false,has_command_=false,has_measurement_=false,overflow_=false;
  double threshold_,limit_,applied_=0,measured_=0,measurement_stamp_=-1;
  Emit emit_;void* context_;Binding binding_;char line_[512];size_t used_=0;
  int64_t last_seq_=-1,measurement_seq_=-1;uint32_t state_seq_=0,last_tick_=0,last_publish_=0,last_command_=0,last_measurement_=0;uint64_t elapsed_=0;
};
}

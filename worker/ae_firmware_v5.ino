// Software-only virtual bench. No motor GPIO, upload or physical encoder.
#include <Arduino.h>
#include "protocol_core_v5.hpp"
#include "model_binding_v5.hpp"
static void emitFrame(void*,const char* text) {Serial.println(text);}
static ae5::ProtocolCore core(ae5_model_binding,emitFrame,nullptr);
void setup() {Serial.begin(921600);}
void loop() {
  unsigned budget=4096;
  while(budget-- && Serial.available()) core.feed(char(Serial.read()),millis());
  core.tick(millis());delay(1);
}

// Bench virtual device only. Compiling this does not verify ESP32 execution.
// No pins, motors, sensors or board upload are used in this project.
#include <Arduino.h>
#include "protocol_core.hpp"
#if __has_include("model_binding.hpp")
#include "model_binding.hpp"
#endif

static void emitFrame(void*,const char* frame) {Serial.println(frame);}
static ae::ProtocolCore core(__JOINT__,__THRESHOLD__,__LIMIT__,emitFrame,nullptr
#ifdef AE_PROTOCOL_V3
  ,ae_model_binding
#endif
);
void setup() {Serial.begin(115200);}
void loop() {
  unsigned budget=512;
  while(budget-- && Serial.available()) core.feed(char(Serial.read()),millis());
  core.tick(millis());
  delay(1);
}

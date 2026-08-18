#pragma once
#include <Arduino.h>

namespace BleTelemetry {

void begin();
void tick();  // call from loop(); sends a notification every NOTIFY_INTERVAL_MS
bool isConnected();
void publishStatus(const char* json);

}  // namespace BleTelemetry

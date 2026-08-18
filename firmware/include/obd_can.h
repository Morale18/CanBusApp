#pragma once
#include <Arduino.h>
#include "vehicle_state.h"

enum ObdPhase : uint8_t {
  PHASE_INIT,       // bringing up the MCP2515
  PHASE_DISCOVER,   // querying which PIDs the ECU supports
  PHASE_RUNNING,    // normal polling
  PHASE_BUS_IDLE    // no responses; ignition presumably off
};

namespace ObdCan {

bool begin();
void tick();  // call from loop(), non-blocking

ObdPhase phase();
bool isSupported(uint8_t pid);

// Bitmap of supported PIDs, indexed 0x00-0x5F. Published to the frontend via
// the device-info characteristic so it only renders gauges the car can feed.
const uint8_t* supportedBitmap();

}  // namespace ObdCan

#pragma once
#include <Arduino.h>
#include "vehicle_state.h"

// ---------------------------------------------------------------------------
// PID table.
//
// To add a PID: write a decoder, add one row to kPidTable. Nothing else in the
// firmware needs to change. The scheduler, discovery and staleness tracking all
// read from this table.
//
// `interval` is how often the PID is requested, in scheduler cycles. RPM and
// speed every cycle; temperatures and fuel level much less often, since they
// move slowly and every slot spent on them is a slot not spent on RPM.
//
// Decoders receive a pointer to the OBD data bytes, i.e. A = d[0], B = d[1].
// ---------------------------------------------------------------------------

typedef void (*DecodeFn)(const uint8_t* d, VehicleState& s);

struct PidEntry {
  uint8_t pid;
  uint8_t interval;
  DecodeFn decode;
  SignalId signal;
  const char* name;
};

// --- Decoders --------------------------------------------------------------

inline void decodeRpm(const uint8_t* d, VehicleState& s) {
  s.rpm = ((d[0] * 256) + d[1]) / 4;
  s.markUpdated(SIG_RPM);
}

inline void decodeSpeed(const uint8_t* d, VehicleState& s) {
  s.speed = d[0];
  s.markUpdated(SIG_SPEED);
}

inline void decodeCoolant(const uint8_t* d, VehicleState& s) {
  s.coolantTemp = (int16_t)d[0] - 40;
  s.markUpdated(SIG_COOLANT);
}

inline void decodeIntake(const uint8_t* d, VehicleState& s) {
  s.intakeTemp = (int16_t)d[0] - 40;
  s.markUpdated(SIG_INTAKE);
}

inline void decodeLoad(const uint8_t* d, VehicleState& s) {
  s.engineLoad = d[0] * 100.0f / 255.0f;
  s.markUpdated(SIG_LOAD);
}

inline void decodeThrottle(const uint8_t* d, VehicleState& s) {
  s.throttle = d[0] * 100.0f / 255.0f;
  s.markUpdated(SIG_THROTTLE);
}

inline void decodeFuel(const uint8_t* d, VehicleState& s) {
  s.fuelLevel = d[0] * 100.0f / 255.0f;
  s.markUpdated(SIG_FUEL);
}

// PID 0x42, not 0x41. 0x41 is "monitor status this drive cycle" (bit flags);
// 0x42 is control module voltage, which is what this formula decodes.
inline void decodeVoltage(const uint8_t* d, VehicleState& s) {
  s.voltage = ((d[0] * 256) + d[1]) / 1000.0f;
  s.markUpdated(SIG_VOLTAGE);
}

// --- Table -----------------------------------------------------------------

static const PidEntry kPidTable[] = {
    {0x0C, 1, decodeRpm, SIG_RPM, "rpm"},
    {0x0D, 1, decodeSpeed, SIG_SPEED, "speed"},
    {0x11, 2, decodeThrottle, SIG_THROTTLE, "throttle"},
    {0x04, 2, decodeLoad, SIG_LOAD, "engineLoad"},
    {0x05, 10, decodeCoolant, SIG_COOLANT, "coolantTemp"},
    {0x0F, 10, decodeIntake, SIG_INTAKE, "intakeTemp"},
    {0x2F, 10, decodeFuel, SIG_FUEL, "fuelLevel"},
    {0x42, 10, decodeVoltage, SIG_VOLTAGE, "voltage"},
};

static const uint8_t kPidCount = sizeof(kPidTable) / sizeof(kPidTable[0]);

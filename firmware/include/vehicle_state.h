#pragma once
#include <Arduino.h>
#include "config.h"

// ---------------------------------------------------------------------------
// Signal indices. These map 1:1 onto bits in the telemetry frame's validMask,
// so the order here is part of the wire protocol - append only, never reorder.
// ---------------------------------------------------------------------------

enum SignalId : uint8_t {
  SIG_RPM = 0,
  SIG_SPEED = 1,
  SIG_COOLANT = 2,
  SIG_INTAKE = 3,
  SIG_LOAD = 4,
  SIG_THROTTLE = 5,
  SIG_FUEL = 6,
  SIG_VOLTAGE = 7,
  SIG_COUNT = 8
};

// canStatus bit flags in the telemetry frame.
enum CanStatusBits : uint8_t {
  CANST_BUS_OK = 1 << 0,
  CANST_LAST_TIMEOUT = 1 << 1,
  CANST_RX_ERROR = 1 << 2,
  CANST_SIMULATED = 1 << 3,
  CANST_DISCOVERY_DONE = 1 << 4
};

// ---------------------------------------------------------------------------
// Decoded vehicle data. Values are stored in natural engineering units and
// only quantised at serialisation time, so adding a higher-resolution
// transport later does not mean re-deriving anything.
// ---------------------------------------------------------------------------

struct VehicleState {
  uint16_t rpm = 0;          // rev/min
  uint8_t speed = 0;         // km/h
  int16_t coolantTemp = 0;   // degC
  int16_t intakeTemp = 0;    // degC
  float engineLoad = 0;      // percent
  float throttle = 0;        // percent
  float fuelLevel = 0;       // percent
  float voltage = 0;         // volts

  // millis() of the last successful update, per signal.
  uint32_t lastUpdate[SIG_COUNT] = {0};

  uint8_t canStatus = 0;
  uint16_t sequence = 0;

  void markUpdated(SignalId s) { lastUpdate[s] = millis(); }

  bool isFresh(SignalId s) const {
    return lastUpdate[s] != 0 && (millis() - lastUpdate[s]) < SIGNAL_STALE_MS;
  }

  // Bitmask of signals currently considered valid. A PID the ECU does not
  // support (Toyota frequently omits fuel level, 0x2F) never sets its bit,
  // so the frontend can grey out that gauge instead of showing a value
  // frozen at whatever it last happened to be.
  uint8_t validMask() const {
    uint8_t m = 0;
    for (uint8_t i = 0; i < SIG_COUNT; i++) {
      if (isFresh((SignalId)i)) m |= (1 << i);
    }
    return m;
  }

  // Newest timestamp across all signals - used to detect an idle bus.
  uint32_t newestUpdate() const {
    uint32_t newest = 0;
    for (uint8_t i = 0; i < SIG_COUNT; i++) {
      if (lastUpdate[i] > newest) newest = lastUpdate[i];
    }
    return newest;
  }
};

extern VehicleState gVehicle;

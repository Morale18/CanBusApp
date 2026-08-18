#include "obd_can.h"

#include "config.h"
#include "obd_pids.h"

#if !USE_SIMULATOR
#include <SPI.h>
#include <mcp_can.h>
static MCP_CAN CAN(CAN_CS_PIN);
#endif

namespace ObdCan {

static ObdPhase gPhase = PHASE_INIT;
static uint8_t gSupported[12] = {0};  // bitmap for PIDs 0x00-0x5F

// Scheduler state
static uint8_t gIdx = 0;
static uint32_t gCycle = 0;
static bool gAwaiting = false;
static uint8_t gAwaitingPid = 0;
static uint32_t gSentAt = 0;
static uint32_t gLastDone = 0;

// Discovery state
static const uint8_t kDiscoverBases[] = {0x00, 0x20, 0x40};
static uint8_t gDiscoverIdx = 0;

// --- Support bitmap helpers ------------------------------------------------

static void setSupported(uint8_t pid) {
  if (pid >= 0x60) return;
  gSupported[pid / 8] |= (1 << (pid % 8));
}

bool isSupported(uint8_t pid) {
  if (pid >= 0x60) return false;
  return gSupported[pid / 8] & (1 << (pid % 8));
}

const uint8_t* supportedBitmap() { return gSupported; }
ObdPhase phase() { return gPhase; }

// --- Transport -------------------------------------------------------------

static void sendRequest(uint8_t pid) {
#if !USE_SIMULATOR
  // Single ISO-TP frame: length byte, mode 01, PID, padding.
  uint8_t req[8] = {0x02, 0x01, pid, 0, 0, 0, 0, 0};
  CAN.sendMsgBuf(OBD_REQUEST_ID, 0, 8, req);
#endif
  gAwaitingPid = pid;
  gAwaiting = true;
  gSentAt = millis();
}

// Parse a Mode 01 supported-PID bitmask response (PIDs 0x00 / 0x20 / 0x40).
// Four data bytes; MSB of the first byte means "base + 1 is supported".
static void parseSupportMask(uint8_t base, const uint8_t* d) {
  for (uint8_t i = 0; i < 32; i++) {
    uint8_t byteIdx = i / 8;
    uint8_t bit = 7 - (i % 8);
    if (d[byteIdx] & (1 << bit)) setSupported(base + 1 + i);
  }
}

static void handleResponse(uint8_t pid, const uint8_t* data) {
  // data points at the raw CAN payload: [len][0x41][pid][A][B]...
  const uint8_t* d = &data[3];

  if (pid == 0x00 || pid == 0x20 || pid == 0x40) {
    parseSupportMask(pid, d);
    return;
  }

  for (uint8_t i = 0; i < kPidCount; i++) {
    if (kPidTable[i].pid == pid) {
      kPidTable[i].decode(d, gVehicle);
      return;
    }
  }
}

// Drain the receive buffer. Returns true if the awaited PID arrived.
static bool pollReceive() {
  bool matched = false;
#if !USE_SIMULATOR
  while (CAN.checkReceive() == CAN_MSGAVAIL) {
    unsigned long id;
    uint8_t len;
    uint8_t buf[8];

    if (CAN.readMsgBuf(&id, &len, buf) != CAN_OK) {
      gVehicle.canStatus |= CANST_RX_ERROR;
      continue;
    }

    if (id < OBD_RESPONSE_ID_MIN || id > OBD_RESPONSE_ID_MAX) continue;
    if (len < 3 || buf[1] != 0x41) continue;  // 0x41 = positive Mode 01 reply

    gVehicle.canStatus |= CANST_BUS_OK;
    handleResponse(buf[2], buf);
    if (buf[2] == gAwaitingPid) matched = true;
  }
#endif
  return matched;
}

// --- Simulator -------------------------------------------------------------
// Lets the whole BLE path be proven on the bench with no car and no MCP2515.

#if USE_SIMULATOR
static void simulateResponse(uint8_t pid) {
  uint32_t t = millis();
  float phase = (t % 12000) / 12000.0f * TWO_PI;
  uint8_t d[4] = {0};

  switch (pid) {
    case 0x00: d[0] = 0xBF; d[1] = 0x9F; d[2] = 0xB9; d[3] = 0x93; break;
    case 0x20: d[0] = 0x80; d[1] = 0x00; d[2] = 0x00; d[3] = 0x01; break;
    case 0x40: d[0] = 0x40; d[1] = 0x00; d[2] = 0x00; d[3] = 0x00; break;
    case 0x0C: {
      uint16_t rpm = 900 + (uint16_t)(2600 * (0.5f + 0.5f * sin(phase)));
      uint16_t raw = rpm * 4;
      d[0] = raw >> 8; d[1] = raw & 0xFF;
      break;
    }
    case 0x0D: d[0] = (uint8_t)(60 + 50 * sin(phase * 0.5f)); break;
    case 0x05: d[0] = 89 + 40; break;
    case 0x0F: d[0] = 31 + 40; break;
    case 0x04: d[0] = (uint8_t)(90 + 60 * sin(phase)); break;
    case 0x11: d[0] = (uint8_t)(58 + 40 * sin(phase)); break;
    case 0x2F: d[0] = 184; break;
    case 0x42: { uint16_t mv = 14100; d[0] = mv >> 8; d[1] = mv & 0xFF; break; }
    default: return;
  }

  uint8_t frame[8] = {0x06, 0x41, pid, d[0], d[1], d[2], d[3], 0};
  handleResponse(pid, frame);
  gVehicle.canStatus |= CANST_BUS_OK | CANST_SIMULATED;
}
#endif

// --- Scheduler -------------------------------------------------------------

// Advance to the next PID due this cycle. Returns 0xFF if none.
static uint8_t nextPid() {
  for (uint8_t attempts = 0; attempts < kPidCount * 2; attempts++) {
    if (gIdx >= kPidCount) {
      gIdx = 0;
      gCycle++;
    }
    const PidEntry& e = kPidTable[gIdx];
    gIdx++;

    if (!isSupported(e.pid)) continue;
    if (gCycle % e.interval != 0) continue;
    return e.pid;
  }
  return 0xFF;
}

// --- Lifecycle -------------------------------------------------------------

bool begin() {
#if USE_SIMULATOR
  gPhase = PHASE_DISCOVER;
  return true;
#else
  SPI.begin();
  uint8_t tries = 0;
  while (CAN.begin(MCP_ANY, CAN_SPEED, CAN_CRYSTAL) != CAN_OK) {
    if (++tries > 10) return false;
    delay(200);
  }
  CAN.setMode(MCP_NORMAL);
  pinMode(CAN_INT_PIN, INPUT_PULLUP);
  gPhase = PHASE_DISCOVER;
  return true;
#endif
}

static void tickDiscover() {
  if (gAwaiting) {
#if USE_SIMULATOR
    simulateResponse(gAwaitingPid);
    gAwaiting = false;
    gLastDone = millis();
#else
    if (pollReceive()) {
      gAwaiting = false;
      gLastDone = millis();
    } else if (millis() - gSentAt > PID_RESPONSE_TIMEOUT_MS) {
      gAwaiting = false;
      gLastDone = millis();
    }
#endif
    return;
  }

  if (millis() - gLastDone < 40) return;

  if (gDiscoverIdx >= sizeof(kDiscoverBases)) {
    // Discovery finished. If the support-bitmask queries got nothing (common
    // when the bus was quiet or the ECU ignored them), fall back to polling
    // the known PID table — same behaviour as the original sketch.
    bool any = false;
    for (uint8_t i = 0; i < kPidCount; i++) {
      if (isSupported(kPidTable[i].pid)) {
        any = true;
        break;
      }
    }
    if (!any) {
      for (uint8_t i = 0; i < kPidCount; i++) setSupported(kPidTable[i].pid);
#if SERIAL_DEBUG
      Serial.println(F("[obd] discovery empty - polling PID table anyway"));
#endif
    }

    gVehicle.canStatus |= CANST_DISCOVERY_DONE;
    gPhase = PHASE_RUNNING;
    gIdx = 0;
    gCycle = 0;

#if SERIAL_DEBUG
    Serial.println(F("[obd] supported PIDs:"));
    for (uint8_t i = 0; i < kPidCount; i++) {
      Serial.printf("  %-12s 0x%02X  %s\n", kPidTable[i].name, kPidTable[i].pid,
                    isSupported(kPidTable[i].pid) ? "yes" : "NO");
    }
#endif
    return;
  }

  sendRequest(kDiscoverBases[gDiscoverIdx++]);
}

static void tickRunning() {
  if (gAwaiting) {
#if USE_SIMULATOR
    simulateResponse(gAwaitingPid);
    gAwaiting = false;
    gLastDone = millis();
#else
    if (pollReceive()) {
      gAwaiting = false;
      gLastDone = millis();
      gVehicle.canStatus &= ~CANST_LAST_TIMEOUT;
    } else if (millis() - gSentAt > PID_RESPONSE_TIMEOUT_MS) {
      gAwaiting = false;
      gLastDone = millis();
      gVehicle.canStatus |= CANST_LAST_TIMEOUT;
    }
#endif
    return;
  }

  if (millis() - gLastDone < PID_GAP_MS) return;

  uint8_t pid = nextPid();
  if (pid != 0xFF) sendRequest(pid);
}

void tick() {
  switch (gPhase) {
    case PHASE_INIT:
      break;

    case PHASE_DISCOVER:
      tickDiscover();
      break;

    case PHASE_RUNNING: {
      tickRunning();
      // No valid response for a long time means the ignition is off and the
      // bus has gone quiet. On the bench this never fires; on a permanent
      // install it is the hook for MCP2515 sleep + ESP32 deep sleep.
      uint32_t newest = gVehicle.newestUpdate();
      if (newest != 0 && millis() - newest > BUS_IDLE_SLEEP_MS) {
        gPhase = PHASE_BUS_IDLE;
        gVehicle.canStatus &= ~CANST_BUS_OK;
      }
      break;
    }

    case PHASE_BUS_IDLE:
      // Probe occasionally; return to RUNNING when the car wakes up.
      if (millis() - gLastDone > 1000) {
        sendRequest(0x0C);
        gLastDone = millis();
        gAwaiting = false;
      }
      pollReceive();
      if (gVehicle.isFresh(SIG_RPM)) {
        gPhase = PHASE_RUNNING;
        gVehicle.canStatus |= CANST_BUS_OK;
      }
      break;
  }
}

}  // namespace ObdCan

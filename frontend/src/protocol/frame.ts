/** Wire protocol: 20-byte little-endian telemetry frame. */

export const FRAME_SIZE = 20;
export const PROTOCOL_VERSION = 1;

/** Append-only — bit order is part of the wire protocol. */
export enum SignalId {
  RPM = 0,
  SPEED = 1,
  COOLANT = 2,
  INTAKE = 3,
  LOAD = 4,
  THROTTLE = 5,
  FUEL = 6,
  VOLTAGE = 7,
}

export const SIGNAL_NAMES: Record<SignalId, string> = {
  [SignalId.RPM]: "rpm",
  [SignalId.SPEED]: "speed",
  [SignalId.COOLANT]: "coolantTemp",
  [SignalId.INTAKE]: "intakeTemp",
  [SignalId.LOAD]: "engineLoad",
  [SignalId.THROTTLE]: "throttle",
  [SignalId.FUEL]: "fuelLevel",
  [SignalId.VOLTAGE]: "voltage",
};

export enum CanStatusBits {
  BUS_OK = 1 << 0,
  LAST_TIMEOUT = 1 << 1,
  RX_ERROR = 1 << 2,
  SIMULATED = 1 << 3,
  DISCOVERY_DONE = 1 << 4,
}

export interface TelemetryFrame {
  version: number;
  validMask: number;
  rpm: number;
  speed: number;
  coolantTemp: number;
  intakeTemp: number;
  engineLoad: number;
  throttle: number;
  fuelLevel: number;
  voltage: number;
  timestamp: number;
  sequence: number;
  canStatus: number;
  reserved: number;
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function i8(view: DataView, offset: number): number {
  return view.getInt8(offset);
}

/** Decode a raw ATT notification payload into engineering units. */
export function parseFrame(bytes: ArrayBuffer | ArrayBufferView): TelemetryFrame {
  const buf =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (buf.byteLength < FRAME_SIZE) {
    throw new Error(`frame too short: ${buf.byteLength} < ${FRAME_SIZE}`);
  }

  const view = new DataView(buf.buffer, buf.byteOffset, FRAME_SIZE);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version: ${version}`);
  }

  return {
    version,
    validMask: view.getUint8(1),
    rpm: u16(view, 2),
    speed: view.getUint8(4),
    coolantTemp: i8(view, 5),
    intakeTemp: i8(view, 6),
    engineLoad: view.getUint8(7) / 2,
    throttle: view.getUint8(8) / 2,
    fuelLevel: view.getUint8(9) / 2,
    voltage: u16(view, 10) / 1000,
    timestamp: u32(view, 12),
    sequence: u16(view, 16),
    canStatus: view.getUint8(18),
    reserved: view.getUint8(19),
  };
}

export function isFresh(frame: TelemetryFrame, signal: SignalId): boolean {
  return (frame.validMask & (1 << signal)) !== 0;
}

/** Encode a frame (used by MockTransport). */
export function encodeFrame(frame: Omit<TelemetryFrame, "version"> & { version?: number }): Uint8Array {
  const out = new Uint8Array(FRAME_SIZE);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.version ?? PROTOCOL_VERSION);
  view.setUint8(1, frame.validMask);
  view.setUint16(2, frame.rpm, true);
  view.setUint8(4, frame.speed);
  view.setInt8(5, frame.coolantTemp);
  view.setInt8(6, frame.intakeTemp);
  view.setUint8(7, Math.round(frame.engineLoad * 2));
  view.setUint8(8, Math.round(frame.throttle * 2));
  view.setUint8(9, Math.round(frame.fuelLevel * 2));
  view.setUint16(10, Math.round(frame.voltage * 1000), true);
  view.setUint32(12, frame.timestamp >>> 0, true);
  view.setUint16(16, frame.sequence, true);
  view.setUint8(18, frame.canStatus);
  view.setUint8(19, frame.reserved);
  return out;
}

export interface DeviceInfoSignal {
  name: string;
  bit: number;
}

export interface DeviceInfo {
  firmware: string;
  protocol: number;
  notifyIntervalMs: number;
  frameSize: number;
  simulated: boolean;
  signals: DeviceInfoSignal[];
}

export function parseDeviceInfo(json: string): DeviceInfo {
  return JSON.parse(json) as DeviceInfo;
}

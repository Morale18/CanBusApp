import {
  CanStatusBits,
  isFresh,
  SignalId,
  SIGNAL_NAMES,
  type DeviceInfo,
  type TelemetryFrame,
} from "../protocol/frame";

export interface Sample {
  t: number;
  value: number;
}

const RING_CAPACITY = 600; // ~60 s at 10 Hz

export class RingBuffer {
  private buf: Sample[] = [];
  private readonly capacity: number;

  constructor(capacity = RING_CAPACITY) {
    this.capacity = capacity;
  }

  push(sample: Sample): void {
    this.buf.push(sample);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }

  values(): readonly Sample[] {
    return this.buf;
  }

  clear(): void {
    this.buf = [];
  }
}

export type StoreListener = (store: VehicleStore) => void;

export class VehicleStore {
  latest: TelemetryFrame | null = null;
  deviceInfo: DeviceInfo | null = null;
  droppedFrames = 0;
  lastFrameAt = 0;
  private lastSequence: number | null = null;

  readonly series: Record<SignalId, RingBuffer> = {
    [SignalId.RPM]: new RingBuffer(),
    [SignalId.SPEED]: new RingBuffer(),
    [SignalId.COOLANT]: new RingBuffer(),
    [SignalId.INTAKE]: new RingBuffer(),
    [SignalId.LOAD]: new RingBuffer(),
    [SignalId.THROTTLE]: new RingBuffer(),
    [SignalId.FUEL]: new RingBuffer(),
    [SignalId.VOLTAGE]: new RingBuffer(),
  };

  private listeners = new Set<StoreListener>();

  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setDeviceInfo(info: DeviceInfo): void {
    this.deviceInfo = info;
    this.notify();
  }

  pushFrame(frame: TelemetryFrame): void {
    if (this.lastSequence !== null) {
      const expected = (this.lastSequence + 1) & 0xffff;
      if (frame.sequence !== expected) {
        const gap = (frame.sequence - expected + 0x10000) & 0xffff;
        this.droppedFrames += gap;
      }
    }
    this.lastSequence = frame.sequence;
    this.latest = frame;
    this.lastFrameAt = performance.now();

    const t = frame.timestamp;
    const push = (id: SignalId, value: number) => {
      if (isFresh(frame, id)) this.series[id].push({ t, value });
    };

    push(SignalId.RPM, frame.rpm);
    push(SignalId.SPEED, frame.speed);
    push(SignalId.COOLANT, frame.coolantTemp);
    push(SignalId.INTAKE, frame.intakeTemp);
    push(SignalId.LOAD, frame.engineLoad);
    push(SignalId.THROTTLE, frame.throttle);
    push(SignalId.FUEL, frame.fuelLevel);
    push(SignalId.VOLTAGE, frame.voltage);

    this.notify();
  }

  reset(): void {
    this.latest = null;
    this.lastSequence = null;
    this.droppedFrames = 0;
    this.lastFrameAt = 0;
    for (let id = 0; id <= SignalId.VOLTAGE; id++) {
      this.series[id as SignalId].clear();
    }
    this.notify();
  }

  signalSupported(id: SignalId): boolean {
    const info = this.deviceInfo;
    if (!info || info.signals.length === 0) return true;
    return info.signals.some((s) => s.bit === id || s.name === SIGNAL_NAMES[id]);
  }

  statusFlags(): string[] {
    const f = this.latest;
    if (!f) return [];
    const flags: string[] = [];
    if (f.canStatus & CanStatusBits.BUS_OK) flags.push("bus");
    if (f.canStatus & CanStatusBits.SIMULATED) flags.push("sim");
    if (f.canStatus & CanStatusBits.DISCOVERY_DONE) flags.push("discovered");
    if (f.canStatus & CanStatusBits.LAST_TIMEOUT) flags.push("timeout");
    if (f.canStatus & CanStatusBits.RX_ERROR) flags.push("rx-err");
    return flags;
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this);
  }
}

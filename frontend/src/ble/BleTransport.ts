import type { DeviceInfo, TelemetryFrame } from "../protocol/frame";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface BleTransportEvents {
  frame: (frame: TelemetryFrame) => void;
  status: (json: string) => void;
  connection: (state: ConnectionState, detail?: string) => void;
  deviceInfo: (info: DeviceInfo) => void;
}

/** Seam between the dashboard and whatever carries frames. */
export interface BleTransport {
  readonly kind: "web" | "mock";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setNotifyRate(ms: number): Promise<void>;
  on<K extends keyof BleTransportEvents>(
    event: K,
    handler: BleTransportEvents[K],
  ): void;
  off<K extends keyof BleTransportEvents>(
    event: K,
    handler: BleTransportEvents[K],
  ): void;
}

type AnyHandler = (...args: never[]) => void;

export abstract class EventedTransport implements BleTransport {
  abstract readonly kind: "web" | "mock";
  private handlers = new Map<keyof BleTransportEvents, Set<AnyHandler>>();

  on<K extends keyof BleTransportEvents>(
    event: K,
    handler: BleTransportEvents[K],
  ): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as AnyHandler);
  }

  off<K extends keyof BleTransportEvents>(
    event: K,
    handler: BleTransportEvents[K],
  ): void {
    this.handlers.get(event)?.delete(handler as AnyHandler);
  }

  protected emit<K extends keyof BleTransportEvents>(
    event: K,
    ...args: Parameters<BleTransportEvents[K]>
  ): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      (handler as unknown as (...a: Parameters<BleTransportEvents[K]>) => void)(
        ...args,
      );
    }
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract setNotifyRate(ms: number): Promise<void>;
}

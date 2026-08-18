import type { ConnectionState } from "../ble/BleTransport";
import { CanStatusBits, isFresh, SignalId, type TelemetryFrame } from "../protocol/frame";
import type { VehicleStore } from "../state/VehicleStore";
import {
  buildSpeedTrace,
  gaugeDash,
  smoothToward,
  SMOOTH_RATES,
} from "./gauge";

type View = "garage" | "vehicle";
type SubView = "live" | "trips";
type Units = "Imperial" | "Metric";

export interface AppHandlers {
  onConnect: () => void;
  onDisconnect: () => void;
}

interface SmoothState {
  rpm: number;
  speed: number;
  throttle: number;
  load: number;
  coolant: number;
  voltage: number;
  fuel: number;
  intake: number;
}

const DASH = "—";

const TRIPS = [
  {
    id: 1,
    name: "Sunnyvale → San Mateo",
    meta: "TODAY · 8:52 AM · 26 min",
    dist: "12.4",
    mpg: "34.8",
    maxSpd: "68 mph",
    idle: "3m 40s",
    peakRpm: "4,180",
    spark:
      "M0 40 L18 32 L36 22 L54 26 L72 14 L90 18 L108 8 L126 16 L144 24 L162 12 L180 10 L198 20 L216 30 L234 22 L252 14 L270 26 L288 34 L300 40",
  },
  {
    id: 2,
    name: "Home → Costco",
    meta: "YESTERDAY · 6:04 PM · 14 min",
    dist: "5.1",
    mpg: "28.3",
    maxSpd: "44 mph",
    idle: "2m 05s",
    peakRpm: "3,240",
    spark: "",
  },
  {
    id: 3,
    name: "Coast run · Hwy 1",
    meta: "SAT · 9:15 AM · 1h 48m",
    dist: "86.2",
    mpg: "36.1",
    maxSpd: "79 mph",
    idle: "6m 12s",
    peakRpm: "5,020",
    spark: "",
  },
  {
    id: 4,
    name: "Airport drop-off",
    meta: "THU · 5:20 AM · 38 min",
    dist: "24.7",
    mpg: "33.0",
    maxSpd: "72 mph",
    idle: "1m 30s",
    peakRpm: "3,910",
    spark: "",
  },
];

function gaugeRingSvg(
  size: number,
  dash: string,
  stroke: string,
  cls: string,
  redZone?: boolean,
): string {
  const dim = size === 112 ? 112 : 104;
  const redArc = redZone
    ? `<circle cx="56" cy="56" r="42" fill="none" stroke="rgba(255,69,58,.55)" stroke-width="7" stroke-linecap="round" stroke-dasharray="18 600" stroke-dashoffset="-180" transform="rotate(135 56 56)"/>`
    : "";
  return `<svg viewBox="0 0 112 112" width="${dim}" height="${dim}">
    <circle cx="56" cy="56" r="52" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="1" stroke-dasharray="1 6"/>
    <circle cx="56" cy="56" r="42" fill="none" stroke="rgba(255,255,255,.075)" stroke-width="7" stroke-linecap="round" stroke-dasharray="198 600" transform="rotate(135 56 56)"/>
    ${redArc}
    <circle cx="56" cy="56" r="42" fill="none" stroke="${stroke}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${dash} 600" transform="rotate(135 56 56)" class="${cls}"/>
  </svg>`;
}

function carVisual(): string {
  return `<div class="car-visual" role="img" aria-label="2022 Toyota Corolla Hatchback XSE"></div>`;
}


function statusIcons(): string {
  return `<svg width="17" height="11" viewBox="0 0 17 11" fill="#F2F4F7"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.6" y="5" width="3" height="6" rx="1"/><rect x="9.2" y="2.6" width="3" height="8.4" rx="1"/><rect x="13.8" y="0" width="3" height="11" rx="1"/></svg>
  <svg width="16" height="11" viewBox="0 0 16 12" fill="none" stroke="#F2F4F7" stroke-width="1.6" stroke-linecap="round"><path d="M1.2 4.4C3 2.7 5.4 1.7 8 1.7s5 1 6.8 2.7"/><path d="M3.6 7.3C4.8 6.2 6.3 5.5 8 5.5s3.2.7 4.4 1.8"/><circle cx="8" cy="10" r=".9" fill="#F2F4F7"/></svg>
  <svg width="25" height="12" viewBox="0 0 25 12"><rect x="0.5" y="0.5" width="21" height="11" rx="3.2" fill="none" stroke="rgba(242,244,247,.4)"/><rect x="2.4" y="2.4" width="15.5" height="7.2" rx="2" fill="#F2F4F7"/><path d="M23 4.2v3.6c1.1-.4 1.6-1 1.6-1.8S24.1 4.6 23 4.2z" fill="rgba(242,244,247,.5)"/></svg>`;
}

export class App {
  private root: HTMLElement;
  private store: VehicleStore;
  private handlers: AppHandlers;
  private mockMode: boolean;

  private view: View = "garage";
  private sub: SubView = "live";
  private units: Units = "Imperial";
  private expandedTrip = 0;
  private connectionState: ConnectionState = "disconnected";
  private flash = false;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  private smooth: SmoothState = {
    rpm: 0,
    speed: 0,
    throttle: 0,
    load: 0,
    coolant: 0,
    voltage: 0,
    fuel: 0,
    intake: 0,
  };
  private lastSmooth = performance.now();
  private frameTimes: number[] = [];
  private rafId = 0;

  private mainEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    store: VehicleStore,
    handlers: AppHandlers,
    mockMode: boolean,
  ) {
    this.root = root;
    this.store = store;
    this.handlers = handlers;
    this.mockMode = mockMode;
    this.renderShell();
    this.store.subscribe(() => this.scheduleUpdate());
    this.loop();
  }

  setConnection(state: ConnectionState, _detail = ""): void {
    const wasConnected = this.connectionState === "connected";
    this.connectionState = state;

    if (state === "connected" && !wasConnected) {
      this.flash = true;
      if (this.flashTimer) clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        this.flash = false;
        this.updateDynamic();
      }, 950);
    }

    if (state === "disconnected" || state === "error") {
      Object.assign(this.smooth, {
        rpm: 0,
        speed: 0,
        throttle: 0,
        load: 0,
        coolant: 0,
        voltage: 0,
        fuel: 0,
        intake: 0,
      });
    }

    this.renderView();
  }

  private isLive(): boolean {
    return this.connectionState === "connected";
  }

  private isConnecting(): boolean {
    return this.connectionState === "connecting";
  }

  private scheduleUpdate(): void {
    // store pushes trigger smooth target updates in loop
  }

  private loop(): void {
    const now = performance.now();
    const dt = Math.min(0.6, (now - this.lastSmooth) / 1000);
    this.lastSmooth = now;

    const frame = this.store.latest;
    const live = this.isLive();

    if (live && frame) {
      const smoothFresh = (
        key: keyof SmoothState,
        signal: SignalId,
        target: number,
        rate: number,
      ) => {
        if (!isFresh(frame, signal)) return;
        this.smooth[key] = smoothToward(
          this.smooth[key] as number,
          target,
          dt,
          rate,
        );
      };

      smoothFresh("rpm", SignalId.RPM, frame.rpm, SMOOTH_RATES.rpm);
      smoothFresh("speed", SignalId.SPEED, frame.speed, SMOOTH_RATES.speed);
      smoothFresh(
        "throttle",
        SignalId.THROTTLE,
        frame.throttle,
        SMOOTH_RATES.throttle,
      );
      smoothFresh("load", SignalId.LOAD, frame.engineLoad, SMOOTH_RATES.load);
      smoothFresh(
        "coolant",
        SignalId.COOLANT,
        frame.coolantTemp,
        SMOOTH_RATES.coolant,
      );
      smoothFresh(
        "voltage",
        SignalId.VOLTAGE,
        frame.voltage,
        SMOOTH_RATES.voltage,
      );
      smoothFresh("fuel", SignalId.FUEL, frame.fuelLevel, SMOOTH_RATES.fuel);
      smoothFresh(
        "intake",
        SignalId.INTAKE,
        frame.intakeTemp,
        SMOOTH_RATES.intake,
      );

      this.frameTimes.push(now);
      while (this.frameTimes.length && now - this.frameTimes[0]! > 1000) {
        this.frameTimes.shift();
      }
    }

    this.updateDynamic();
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="page-wrap">
        <div class="phone">
          ${this.mockMode ? '<div class="mock-banner">MOCK DATA</div>' : ""}
          <div class="status-bar">
            <div class="status-bar-time" id="clock"></div>
            <div class="status-bar-icons">${statusIcons()}</div>
          </div>
          <div class="scroll-main" id="main"></div>
          <div class="home-indicator"><div class="home-bar"><div class="home-bar-pill"></div></div></div>
        </div>
      </div>`;

    this.mainEl = this.root.querySelector("#main")!;
    this.updateClock();
    setInterval(() => this.updateClock(), 30000);
    this.renderView();
  }

  private updateClock(): void {
    const el = this.root.querySelector("#clock");
    if (!el) return;
    const d = new Date();
    el.textContent = d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  private renderView(): void {
    this.mainEl.innerHTML =
      this.view === "garage" ? this.renderGarage() : this.renderVehicle();
    this.bindViewEvents();
    this.updateDynamic();
  }

  private bindViewEvents(): void {
    this.mainEl.querySelector("#btn-conn")?.addEventListener("click", () => {
      if (this.isLive() || this.isConnecting()) this.handlers.onDisconnect();
      else this.handlers.onConnect();
    });

    this.mainEl.querySelector("#open-vehicle")?.addEventListener("click", () => {
      this.view = "vehicle";
      this.sub = "live";
      this.renderView();
    });

    this.mainEl.querySelector("#go-back")?.addEventListener("click", () => {
      this.view = "garage";
      this.renderView();
    });

    this.mainEl.querySelector("#seg-live")?.addEventListener("click", () => {
      this.sub = "live";
      this.renderView();
    });

    this.mainEl.querySelector("#seg-trips")?.addEventListener("click", () => {
      this.sub = "trips";
      this.renderView();
    });

    TRIPS.forEach((t) => {
      this.mainEl
        .querySelector(`#trip-${t.id}`)
        ?.addEventListener("click", () => {
          this.expandedTrip = this.expandedTrip === t.id ? 0 : t.id;
          this.renderView();
        });
    });
  }

  private connDot(): string {
    if (this.isLive())
      return `<div class="status-dot-wrap"><div class="status-dot live"></div><div class="status-dot ring"></div></div>`;
    if (this.isConnecting())
      return `<div class="status-dot-wrap"><div class="status-dot connecting"></div></div>`;
    return `<div class="status-dot-wrap"><div class="status-dot idle"></div></div>`;
  }

  private renderGarage(): string {
    const live = this.isLive();
    const connecting = this.isConnecting();
    const pillLabel = live ? "LIVE" : connecting ? "LINKING" : "OFFLINE";
    const pillColor = live ? "var(--accent-bright)" : "var(--text-muted)";

    return `<div class="view-garage">
      <div class="garage-header">
        <div>
          <div class="eyebrow">CANBUSAPP</div>
          <div class="title-xl">Garage</div>
          <div class="subtitle-mono">1 VEHICLE · OBD-II LINKED</div>
        </div>
        <button type="button" class="icon-btn" aria-label="Settings">
          <svg width="15" height="19" viewBox="0 0 15 19" fill="none" stroke="#FFB020" stroke-width="1.5" stroke-linejoin="round"><path d="M7.5 1v17l5.2-4.7L2.3 5.7M7.5 1l5.2 4.7L2.3 13.3"/></svg>
        </button>
      </div>

      <div class="card conn-card" id="conn-card">
        ${live ? '<div class="conn-shimmer"></div>' : ""}
        ${this.flash ? '<div class="conn-flash"></div>' : ""}
        <div class="conn-row">
          <div class="conn-left">
            ${this.connDot()}
            <div>
              <div class="conn-label" id="conn-label">${live ? "Live · CAN bus" : connecting ? "Handshaking…" : "Disconnected"}</div>
              <div class="conn-sub" id="conn-sub">${live ? "OBD2-ESP32-v1 · 500 kbps" : connecting ? "ISO-TP · requesting PIDs" : "Adapter not linked"}</div>
            </div>
          </div>
          <button type="button" class="btn-pill ${live ? "live" : "connect"}" id="btn-conn">${live ? "Disconnect" : connecting ? "Cancel" : "Connect"}</button>
        </div>
        <div class="stat-grid-3">
          <div><div class="stat-label">FRAMES</div><div class="stat-value ${live ? "live" : "dim"}" id="stat-fps">${DASH}</div></div>
          <div><div class="stat-label">LATENCY</div><div class="stat-value ${live ? "live" : "dim"}" id="stat-lat">${DASH}</div></div>
          <div><div class="stat-label">PROTOCOL</div><div class="stat-value" style="color:#B7C0CC">ISO 15765</div></div>
        </div>
      </div>

      <div class="card-flat card-clickable vehicle-card" id="open-vehicle">
        <div class="vehicle-card-top">
          <div class="vehicle-row">
          <div>
            <div class="vehicle-title">Corolla Hatchback</div>
            <div class="vehicle-meta">2022 · XSE · 2.0L M20A-FKS</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="vehicle-pill" style="color:${pillColor}">${pillLabel}</div>
            <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="#5E6875" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l6 6-6 6"/></svg>
          </div>
        </div>
        </div>
        ${carVisual()}
        <div class="mini-stats">
          <div><div class="mini-stat-label">ENGINE</div><div class="mini-stat-value" id="mini-engine">${DASH}</div></div>
          <div><div class="mini-stat-label">BATTERY</div><div class="mini-stat-value" id="mini-volt">${DASH}</div></div>
          <div><div class="mini-stat-label">TPMS</div><div class="mini-stat-value">34 psi</div></div>
          <div><div class="mini-stat-label">CODES</div><div class="mini-stat-value">None</div></div>
        </div>
      </div>

      <div class="card-flat trip-card card-clickable soft">
        <div class="trip-header">
          <div class="trip-title">Current trip</div>
          <div class="trip-time">SINCE 8:52 AM</div>
        </div>
        <div class="trip-metrics">
          <div><div class="metric-xl" id="trip-dist">${DASH}</div><div class="metric-label">${this.units === "Metric" ? "KILOMETRES" : "MILES"}</div></div>
          <div><div class="metric-xl accent" id="trip-econ">${DASH}</div><div class="metric-label">${this.units === "Metric" ? "L/100KM" : "MPG"} AVG</div></div>
          <div><div class="metric-xl">26<span class="metric-unit"> min</span></div><div class="metric-label">DURATION</div></div>
        </div>
      </div>

      <div class="add-vehicle">
        <div class="add-icon"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#FFB020" stroke-width="1.9" stroke-linecap="round"><path d="M7 1.6v10.8M1.6 7h10.8"/></svg></div>
        <div><div style="font-size:14px;font-weight:600;color:var(--text-soft)">Add a vehicle</div><div class="subtitle-mono" style="margin-top:3px;font-size:10px;color:var(--text-dim)">PAIR ANOTHER OBD-II ADAPTER</div></div>
      </div>
    </div>`;
  }

  private renderVehicle(): string {
    const live = this.isLive();
    const connecting = this.isConnecting();
    const pillLabel = live ? "LIVE" : connecting ? "LINKING" : "OFFLINE";
    const pillBg = live ? "rgba(255,176,32,.12)" : "rgba(255,255,255,.04)";
    const pillBorder = live ? "rgba(255,176,32,.32)" : "rgba(255,255,255,.08)";
    const pillFg = live ? "var(--accent-bright)" : "var(--text-muted)";
    const dotCls = live ? "status-dot live" : "status-dot idle";

    return `<div class="view-vehicle">
      <div class="vehicle-header">
        <button type="button" class="icon-btn sm" id="go-back" aria-label="Back">
          <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="#F2F4F7" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1L1 7l6 6"/></svg>
        </button>
        <div class="vehicle-header-title">
          <div class="vehicle-header-name">Corolla Hatchback</div>
          <div class="subtitle-mono" id="vehicle-subtitle" style="margin-top:4px;font-size:10px">${this.pidSummary()}</div>
        </div>
        <div class="live-pill" style="background:${pillBg};border:1px solid ${pillBorder}">
          <div class="live-pill-dot"><div class="${dotCls}" style="position:absolute;inset:0;border-radius:50%${live ? ";animation:dotPulse 1.6s ease-in-out infinite" : ""}"></div></div>
          <div class="live-pill-label" style="color:${pillFg}">${pillLabel}</div>
        </div>
      </div>

      <div class="seg-control">
        <button type="button" class="seg-btn ${this.sub === "live" ? "active" : ""}" id="seg-live">Live</button>
        <button type="button" class="seg-btn ${this.sub === "trips" ? "active" : ""}" id="seg-trips">Trips</button>
      </div>

      ${this.sub === "live" ? this.renderLive() : this.renderTrips()}
    </div>`;
  }

  private renderLive(): string {
    const gauge = (
      id: string,
      size: "lg" | "md",
      stroke: string,
      cls: string,
      caption: string,
      valueKey: string,
      unit: string,
      valueCls: string,
      redZone = false,
    ) => {
      const dim = size === "lg" ? 112 : 104;
      return `<div class="gauge-card" id="${id}">
        <div class="gauge-ring-wrap ${size}">
          ${gaugeRingSvg(dim, "0", stroke, cls, redZone)}
          <div class="gauge-center">
            <div class="gauge-value ${valueCls}" data-v="${valueKey}">${DASH}</div>
            <div class="gauge-unit">${unit}</div>
          </div>
        </div>
        <div class="gauge-caption">${caption}</div>
      </div>`;
    };

    return `<div class="view-live">
      <div class="gauge-grid">
        ${gauge("g-rpm", "lg", "#FFB020", "arc-rpm", "ENGINE SPEED", "rpm", "RPM", "lg", true)}
        ${gauge("g-spd", "lg", "#FFFFFF", "arc-speed", "VEHICLE SPEED", "spd", this.units === "Metric" ? "KM/H" : "MPH", "xl")}
        ${gauge("g-thr", "md", "#FFB020", "arc-thr", "THROTTLE", "thr", "%", "md")}
        ${gauge("g-load", "md", "#8B95A3", "arc-load", "ENGINE LOAD", "load", "%", "md")}
        ${gauge("g-ect", "md", "#FFB020", "arc-ect", "COOLANT", "ect", this.units === "Metric" ? "°C" : "°F", "md")}
        ${gauge("g-volt", "md", "#FFB020", "arc-volt", "CONTROL MODULE", "volt", "VOLTS", "md")}
      </div>

      <div class="trace-card">
        <div class="trace-header">
          <div class="trace-title">Speed trace</div>
          <div class="stat-label">LAST 20 s</div>
        </div>
        <div style="position:relative;height:116px">
          <svg viewBox="0 0 330 116" preserveAspectRatio="none" style="width:100%;height:116px;overflow:visible" id="trace-svg">
            <defs><linearGradient id="traceFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(255,176,32,.32)"/><stop offset="100%" stop-color="rgba(255,176,32,0)"/></linearGradient></defs>
            <line x1="0" y1="29" x2="330" y2="29" stroke="rgba(255,255,255,.055)" stroke-width="1"/>
            <line x1="0" y1="58" x2="330" y2="58" stroke="rgba(255,255,255,.055)" stroke-width="1"/>
            <line x1="0" y1="87" x2="330" y2="87" stroke="rgba(255,255,255,.055)" stroke-width="1"/>
            <path id="trace-area" fill="url(#traceFill)" d=""/>
            <path id="trace-line" class="trace-line" fill="none" stroke="#FFB020" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" d=""/>
            <circle id="trace-tip-outer" class="trace-tip-outer" cx="330" cy="108" r="8" fill="rgba(255,176,32,.18)"/>
            <circle id="trace-tip" cx="330" cy="108" r="3.2" fill="#FFB020"/>
          </svg>
        </div>
        <div class="trace-axis"><span>-20 s</span><span>-10 s</span><span>NOW</span></div>
      </div>

      <div class="dual-grid">
        <div class="card-flat">
          <div class="stat-label">FUEL LEVEL</div>
          <div class="metric-xl" style="font-size:22px;margin-top:8px" data-v="fuel">${DASH}</div>
          <div class="fuel-bar"><div class="fuel-fill" id="fuel-fill" style="width:0%"></div></div>
        </div>
        <div class="card-flat">
          <div class="stat-label">INTAKE AIR</div>
          <div class="metric-xl" style="font-size:22px;margin-top:8px" data-v="iat">${DASH}</div>
          <div class="subtitle-mono" style="margin-top:14px;font-size:10px">MAF — g/s</div>
        </div>
      </div>
    </div>`;
  }

  private renderTrips(): string {
    const items = TRIPS.map(
      (t) => `
      <div class="trip-item" id="trip-${t.id}">
        <div class="trip-item-row">
          <div>
            <div class="trip-item-name">${t.name}</div>
            <div class="trip-item-meta">${t.meta}</div>
          </div>
          <div class="trip-item-right">
            <div style="font-size:17px;font-weight:700;letter-spacing:-.3px">${t.dist}<span style="font-size:11px;font-weight:500;color:#8B95A3"> mi</span></div>
            <div style="font-family:var(--font-mono);font-size:10.5px;color:var(--accent);margin-top:5px">${t.mpg} mpg</div>
          </div>
        </div>
        ${
          this.expandedTrip === t.id
            ? `<div class="trip-expand">
            ${t.spark ? `<svg viewBox="0 0 300 48" preserveAspectRatio="none" style="width:100%;height:48px"><path d="${t.spark}" fill="none" stroke="rgba(255,176,32,.75)" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>` : ""}
            <div class="stat-grid-3" style="margin-top:12px;border:none;padding:0">
              <div><div class="stat-label">MAX SPEED</div><div style="font-size:14px;font-weight:600;margin-top:4px">${t.maxSpd}</div></div>
              <div><div class="stat-label">IDLE TIME</div><div style="font-size:14px;font-weight:600;margin-top:4px">${t.idle}</div></div>
              <div><div class="stat-label">PEAK RPM</div><div style="font-size:14px;font-weight:600;margin-top:4px">${t.peakRpm}</div></div>
            </div>
          </div>`
            : ""
        }
      </div>`,
    ).join("");

    return `<div class="view-trips">
      <div class="stat-label" style="padding:0 4px 10px">14 LOGGED · THIS WEEK</div>
      <div class="trips-summary">
        <div class="trip-metrics">
          <div><div class="metric-xl">148<span class="metric-unit"> mi</span></div><div class="metric-label" style="color:#8A7A5C">DISTANCE</div></div>
          <div><div class="metric-xl accent">31.2</div><div class="metric-label" style="color:#8A7A5C">MPG AVG</div></div>
          <div><div class="metric-xl">4<span class="metric-unit">h </span>12<span class="metric-unit">m</span></div><div class="metric-label" style="color:#8A7A5C">DRIVE TIME</div></div>
        </div>
      </div>
      <div class="trips-list">${items}</div>
    </div>`;
  }

  private speedDisplay(kmh: number): number {
    return this.units === "Metric" ? kmh : kmh * 0.621371;
  }

  private tempDisplay(celsius: number): number {
    return this.units === "Metric"
      ? celsius
      : Math.round(celsius * (9 / 5) + 32);
  }

  private pidSummary(): string {
    const count = this.store.deviceInfo?.signals.length;
    const pidText =
      count && count > 0 ? `${count} PIDs polled` : "Polling PIDs…";
    return `${pidText} · ISO 15765-4`;
  }

  private connLabelText(): string {
    if (this.isConnecting()) return "Handshaking…";
    if (!this.isLive()) return "Disconnected";

    const frame = this.store.latest;
    if (!frame) return "Live · waiting for data";

    if (frame.canStatus & CanStatusBits.LAST_TIMEOUT) {
      return "Live · waiting for ECU";
    }
    if (frame.canStatus & CanStatusBits.RX_ERROR) {
      return "Live · CAN receive error";
    }
    if (frame.canStatus & CanStatusBits.DISCOVERY_DONE) {
      return "Live · CAN bus";
    }
    return "Live · discovering PIDs";
  }

  private connSubText(): string {
    if (this.isConnecting()) return "ISO-TP · requesting PIDs";
    if (!this.isLive()) return "Adapter not linked";

    const info = this.store.deviceInfo;
    const fw = info?.firmware ?? "OBD2-ESP32-v1";
    const pidCount = info?.signals.length ?? 0;
    const sim =
      info?.simulated || (this.store.latest?.canStatus ?? 0) & CanStatusBits.SIMULATED
        ? " · sim"
        : "";
    const pids = pidCount > 0 ? ` · ${pidCount} PIDs` : "";
    return `${fw} · 500 kbps${pids}${sim}`;
  }

  private frameLatencyMs(): number | null {
    if (!this.store.lastFrameAt) return null;
    return Math.max(0, Math.round(performance.now() - this.store.lastFrameAt));
  }

  private engineStatus(frame: TelemetryFrame | null): string {
    if (!frame || !isFresh(frame, SignalId.RPM)) return DASH;
    if (this.smooth.rpm <= 400) return "Off";
    return `${Math.round(this.smooth.rpm).toLocaleString()} RPM`;
  }

  private liveValue(
    live: boolean,
    frame: TelemetryFrame | null,
    signal: SignalId,
    text: string,
  ): string {
    if (!live) return DASH;
    if (!frame || !isFresh(frame, signal)) return "stale";
    return text;
  }

  private updateDynamic(): void {
    const live = this.isLive();
    const frame = this.store.latest;
    const s = this.smooth;
    const D = DASH;

    const setText = (sel: string, text: string) => {
      const el = this.mainEl.querySelector(sel);
      if (el) el.textContent = text;
    };

    const setGaugeState = (
      id: string,
      stale: boolean,
      supported: boolean,
    ) => {
      const el = this.mainEl.querySelector(id);
      if (!el) return;
      el.classList.toggle("gauge-stale", stale);
      el.classList.toggle("gauge-unsupported", !supported);
    };

    const fresh = (id: SignalId) => !!frame && isFresh(frame, id);
    const supported = (id: SignalId) => this.store.signalSupported(id);

    // Garage + connection card
    setText("#conn-label", this.connLabelText());
    setText("#conn-sub", this.connSubText());
    setText("#stat-fps", live ? `${this.frameTimes.length}/s` : D);
    const latency = this.frameLatencyMs();
    setText("#stat-lat", live && latency !== null ? `${latency} ms` : D);
    setText("#mini-engine", this.engineStatus(frame));
    setText(
      "#mini-volt",
      this.liveValue(
        live,
        frame,
        SignalId.VOLTAGE,
        `${this.smooth.voltage.toFixed(1)} V`,
      ),
    );

    // Vehicle header subtitle
    setText("#vehicle-subtitle", this.pidSummary());

    if (this.view !== "vehicle" || this.sub !== "live") return;

    const rpmText = this.liveValue(
      live,
      frame,
      SignalId.RPM,
      Math.round(this.smooth.rpm).toLocaleString(),
    );
    const spdShown = this.speedDisplay(this.smooth.speed);
    const spdText = this.liveValue(
      live,
      frame,
      SignalId.SPEED,
      String(Math.round(spdShown)),
    );
    const thrText = this.liveValue(
      live,
      frame,
      SignalId.THROTTLE,
      String(Math.round(this.smooth.throttle)),
    );
    const loadText = this.liveValue(
      live,
      frame,
      SignalId.LOAD,
      String(Math.round(this.smooth.load)),
    );
    const ectShown = this.tempDisplay(this.smooth.coolant);
    const ectText = this.liveValue(
      live,
      frame,
      SignalId.COOLANT,
      String(Math.round(ectShown)),
    );
    const voltText = this.liveValue(
      live,
      frame,
      SignalId.VOLTAGE,
      this.smooth.voltage.toFixed(1),
    );
    const fuelText = this.liveValue(
      live,
      frame,
      SignalId.FUEL,
      `${Math.round(this.smooth.fuel)}%`,
    );
    const iatShown = this.tempDisplay(this.smooth.intake);
    const iatText = this.liveValue(
      live,
      frame,
      SignalId.INTAKE,
      `${Math.round(iatShown)}${this.units === "Metric" ? "°C" : "°F"}`,
    );

    setText('[data-v="rpm"]', rpmText);
    setText('[data-v="spd"]', spdText);
    setText('[data-v="thr"]', thrText);
    setText('[data-v="load"]', loadText);
    setText('[data-v="ect"]', ectText);
    setText('[data-v="volt"]', voltText);
    setText('[data-v="fuel"]', fuelText);
    setText('[data-v="iat"]', iatText);

    const fuelFill = this.mainEl.querySelector("#fuel-fill") as HTMLElement | null;
    if (fuelFill) {
      fuelFill.style.width =
        live && fresh(SignalId.FUEL) ? `${Math.round(s.fuel)}%` : "0%";
    }

    const spdMax = this.units === "Metric" ? 200 : 130;
    const ectColor = s.coolant > 100 ? "var(--danger)" : "var(--accent)";

    const arc = (
      sel: string,
      signal: SignalId,
      fraction: number,
      stroke?: string,
    ) => {
      if (live && fresh(signal)) {
        this.setArc(sel, gaugeDash(fraction), stroke);
      } else if (!live) {
        this.setArc(sel, "0", stroke);
      }
    };

    arc("#g-rpm .arc-rpm", SignalId.RPM, s.rpm / 7000);
    arc("#g-spd .arc-speed", SignalId.SPEED, spdShown / spdMax);
    arc("#g-thr .arc-thr", SignalId.THROTTLE, s.throttle / 100);
    arc("#g-load .arc-load", SignalId.LOAD, s.load / 100);
    arc("#g-ect .arc-ect", SignalId.COOLANT, (s.coolant - 40) / 80, ectColor);
    arc("#g-volt .arc-volt", SignalId.VOLTAGE, (s.voltage - 11) / 4);

    setGaugeState(
      "#g-rpm",
      live && !fresh(SignalId.RPM),
      supported(SignalId.RPM),
    );
    setGaugeState(
      "#g-spd",
      live && !fresh(SignalId.SPEED),
      supported(SignalId.SPEED),
    );
    setGaugeState(
      "#g-thr",
      live && !fresh(SignalId.THROTTLE),
      supported(SignalId.THROTTLE),
    );
    setGaugeState(
      "#g-load",
      live && !fresh(SignalId.LOAD),
      supported(SignalId.LOAD),
    );
    setGaugeState(
      "#g-ect",
      live && !fresh(SignalId.COOLANT),
      supported(SignalId.COOLANT),
    );
    setGaugeState(
      "#g-volt",
      live && !fresh(SignalId.VOLTAGE),
      supported(SignalId.VOLTAGE),
    );

    const speeds = this.store.series[SignalId.SPEED]
      .values()
      .map((x) => this.speedDisplay(x.value));
    const traceMax = this.units === "Metric" ? 140 : 90;
    const trace = buildSpeedTrace(speeds, traceMax);
    const area = this.mainEl.querySelector("#trace-area") as SVGPathElement | null;
    const line = this.mainEl.querySelector("#trace-line") as SVGPathElement | null;
    const tip = this.mainEl.querySelector("#trace-tip") as SVGCircleElement | null;
    const tipO = this.mainEl.querySelector("#trace-tip-outer") as SVGCircleElement | null;
    if (area) area.setAttribute("d", trace.areaPath);
    if (line) line.setAttribute("d", trace.tracePath);
    if (tip) {
      tip.setAttribute("cx", trace.tipX);
      tip.setAttribute("cy", trace.tipY);
    }
    if (tipO) {
      tipO.setAttribute("cx", trace.tipX);
      tipO.setAttribute("cy", trace.tipY);
    }
  }

  private setArc(sel: string, dash: string, stroke?: string): void {
    const el = this.mainEl.querySelector(sel) as SVGCircleElement | null;
    if (!el) return;
    el.setAttribute("stroke-dasharray", `${dash} 600`);
    if (stroke) el.setAttribute("stroke", stroke);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    if (this.flashTimer) clearTimeout(this.flashTimer);
  }
}

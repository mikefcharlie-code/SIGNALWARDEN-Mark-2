import type { GlobeBounds } from "./worldview-globe-viewport";

export const SAR_VIEWPORT_DEBOUNCE_MS = 750;
export const SAR_VIEWPORT_MIN_INTERVAL_MS = 60_000;
export const SAR_VIEWPORT_CADENCE_MS = 15 * 60_000;
export type ViewportRefreshState = "stopped" | "no-viewport" | "scheduled" | "loading" | "updated" | "no-coverage" | "failed";
type Config = Readonly<{ enabled: boolean; sourceSelected: boolean; active: boolean; bounds: readonly GlobeBounds[] }>;
type RefreshResult = "updated" | "no-coverage";
type Clock = Readonly<{
  now: () => number;
  setTimeout: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}>;
const systemClock: Clock = { now: () => Date.now(), setTimeout: (fn, delay) => globalThis.setTimeout(fn, delay), clearTimeout: (id) => globalThis.clearTimeout(id) };
export type ViewportRefreshDependencies = Readonly<{
  refresh: (bounds: readonly GlobeBounds[], signal: AbortSignal) => Promise<RefreshResult>;
  onState: (state: ViewportRefreshState, error?: unknown) => void;
  clear: () => void;
  clock?: Clock;
}>;

/** One current viewport, one in-flight request, a 750 ms debounce, and a hard 1/minute source limit. */
export class ViewportRefreshController {
  private readonly clock: Clock;
  private enabled = false;
  private bounds: readonly GlobeBounds[] = [];
  private key = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private lastStartedAt: number | null = null;
  private generation = 0;

  constructor(private readonly dependencies: ViewportRefreshDependencies) {
    this.clock = dependencies.clock ?? systemClock;
  }

  configure(config: Config): void {
    const shouldRun = config.enabled && config.sourceSelected && config.active;
    if (!shouldRun) {
      if (this.enabled || this.timer || this.request) this.stop();
      return;
    }
    const nextBounds = config.bounds.slice(0, 2).filter((bounds) =>
      Number.isFinite(bounds.west) && Number.isFinite(bounds.east) && Number.isFinite(bounds.south) && Number.isFinite(bounds.north) &&
      bounds.west < bounds.east && bounds.south < bounds.north,
    );
    const nextKey = JSON.stringify(nextBounds);
    if (!this.enabled) {
      this.enabled = true;
      this.bounds = nextBounds;
      this.key = nextKey;
      this.schedule(this.nextStartDelay());
      return;
    }
    if (nextKey !== this.key) {
      this.bounds = nextBounds;
      this.key = nextKey;
      this.cancelTimer();
      this.cancelRequest();
      this.schedule(this.nextStartDelay());
    }
  }

  dispose(): void {
    if (this.enabled || this.timer || this.request) this.stop();
  }

  private schedule(delay: number, publish = true): void {
    this.cancelTimer();
    if (!this.bounds.length) {
      this.dependencies.onState("no-viewport");
      return;
    }
    if (publish) this.dependencies.onState("scheduled");
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.run(); }, Math.max(0, delay));
  }

  private async run(): Promise<void> {
    if (!this.enabled || !this.bounds.length) {
      if (this.enabled) this.dependencies.onState("no-viewport");
      return;
    }
    const version = ++this.generation;
    const controller = new AbortController();
    this.request = controller;
    this.lastStartedAt = this.clock.now();
    const submitted = this.bounds;
    this.dependencies.onState("loading");
    try {
      const result = await this.dependencies.refresh(submitted, controller.signal);
      if (version !== this.generation || controller.signal.aborted || !this.enabled) return;
      this.dependencies.onState(result === "updated" ? "updated" : "no-coverage");
      this.schedule(SAR_VIEWPORT_CADENCE_MS, false);
    } catch (error) {
      if (version !== this.generation || controller.signal.aborted || !this.enabled) return;
      this.dependencies.onState("failed", error);
      this.schedule(SAR_VIEWPORT_CADENCE_MS, false);
    } finally {
      if (version === this.generation) this.request = null;
    }
  }

  private stop(): void {
    this.enabled = false;
    this.key = "";
    this.bounds = [];
    this.cancelTimer();
    this.cancelRequest();
    this.dependencies.clear();
    this.dependencies.onState("stopped");
  }

  private cancelTimer(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private cancelRequest(): void {
    this.generation++;
    this.request?.abort();
    this.request = null;
  }

  private nextStartDelay(): number {
    if (this.lastStartedAt === null) return SAR_VIEWPORT_DEBOUNCE_MS;
    const sinceStart = this.clock.now() - this.lastStartedAt;
    return Math.max(SAR_VIEWPORT_DEBOUNCE_MS, SAR_VIEWPORT_MIN_INTERVAL_MS - sinceStart);
  }
}

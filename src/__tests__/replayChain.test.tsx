import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useTradingStore } from "@/services/store";
import { useReplayChartData } from "@/pages/trading/useReplayChartData";
import { useReplayPlayback } from "@/pages/trading/useReplayPlayback";

/**
 * Integration harness for the multi-day replay chain: renders the REAL
 * useReplayChartData + useReplayPlayback pair (in the same order context.tsx
 * uses) with a scripted per-day session source and a manually driven rAF
 * clock, then asserts the day-after-day chaining behaviour end to end.
 */

type TickBar = { t: number; o: number; h: number; l: number; c: number; v: number };

const ONE_MIN = 60_000;
const BARS_PER_DAY = 1440;

/** Scripted state the mocked session source reads. */
const harness = vi.hoisted(() => ({
  /** date -> how many times that date's query has been "fetched" (0 => in flight). */
  served: new Map<string, number>(),
  /** dates whose buffer is empty (weekends / outages). */
  emptyDays: new Set<string>(),
}));

function dayStartMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

/** 1440 flat 1m bars spanning the date's local-midnight window. */
function bufferFor(date: string): TickBar[] {
  const start = dayStartMs(date);
  const out: TickBar[] = [];
  for (let i = 0; i < BARS_PER_DAY; i++) {
    const t = start + i * ONE_MIN;
    out.push({ t, o: 100, h: 101, l: 99, c: 100.5, v: 1 });
  }
  return out;
}

vi.mock("@/services/queries", () => ({
  useReplaySession: (accountId: string | null, sessionDate: string | null) => {
    if (!accountId || !sessionDate) return { data: undefined };
    const calls = harness.served.get(sessionDate) ?? 0;
    harness.served.set(sessionDate, calls + 1);
    if (calls === 0) return { data: undefined }; // fetch in flight
    const buf = harness.emptyDays.has(sessionDate) ? [] : bufferFor(sessionDate);
    return {
      data: {
        replaySession: {
          id: "session-1",
          status: "PLAYING",
          speed: 1,
          cursorTimestamp: null,
          sessionDate,
        },
        tickBuffer: buf,
        tradeEvents: [],
        meta: { primarySymbol: "BTCUSDT", sessionDate, tickCount: buf.length },
      },
    };
  },
}));

vi.mock("@/services/api", () => ({
  api: {
    replayGetSession: vi.fn(),
    replayPatchSession: vi.fn(async () => ({})),
    replayStop: vi.fn(async () => ({})),
  },
}));

vi.mock("@/services/toast", () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

let pendingRaf: ((time: number) => void) | null = null;
let clock = 0;

/** Advance the manually driven rAF clock `count` frames (100ms each). */
function drive(count: number): void {
  for (let i = 0; i < count; i++) {
    const cb = pendingRaf;
    pendingRaf = null;
    clock += 100;
    if (cb) act(() => cb(clock));
  }
}

function storeState() {
  return useTradingStore.getState();
}

describe("multi-day replay chain", () => {
  beforeEach(() => {
    harness.served.clear();
    harness.emptyDays.clear();
    pendingRaf = null;
    clock = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: (time: number) => void) => {
        pendingRaf = cb;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useTradingStore.setState({
      isReplaying: true,
      replayPaused: false,
      replaySpeed: 50, // 5 bars per 100ms frame — a day passes in ~288 frames
      replayCursorTimestamp: null,
      replaySessionDate: "2026-11-01",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mountChain() {
    return renderHook(() => {
      // Same order as terminal/context.tsx: chart data first, playback second.
      const chart = useReplayChartData("acc-1", "1m");
      useReplayPlayback("acc-1", 60000);
      return chart;
    });
  }

  it("plays Nov 1, then chains into Nov 2 keeping the full history", () => {
    const { result } = mountChain();

    drive(4); // bootstrap + first bars of Nov 1
    let candles = result.current.replayCandles;
    expect(candles).not.toBeNull();
    expect(candles![0]!.time).toBe(dayStartMs("2026-11-01"));

    drive(400); // consume Nov 1 (~288 frames) + seam + Nov 2 start

    expect(storeState().replaySessionDate).toBe("2026-11-02");
    expect(storeState().isReplaying).toBe(true);

    candles = result.current.replayCandles;
    expect(candles).not.toBeNull();
    const times = candles!.map((c) => c.time);
    // The user-visible bug: the seam must not duplicate or drop the played day.
    expect(new Set(times).size).toBe(times.length);
    expect(times[0]).toBe(dayStartMs("2026-11-01"));
    expect(times[times.length - 1]!).toBeGreaterThanOrEqual(dayStartMs("2026-11-02"));

    drive(100); // keep playing inside Nov 2 (~500 more market minutes)

    expect(storeState().replaySessionDate).toBe("2026-11-02");
    candles = result.current.replayCandles!;
    expect(candles[candles.length - 1]!.time).toBeGreaterThanOrEqual(
      dayStartMs("2026-11-02") + 900 * ONE_MIN,
    );
    // The chain must not have stopped the session along the way.
    expect(vi.mocked(api.replayStop)).not.toHaveBeenCalled();
  });

  it("chains Nov 2 → Nov 3 as each day ends (multi-day run)", () => {
    const { result } = mountChain();

    drive(450); // all of Nov 1 + seam
    expect(storeState().replaySessionDate).toBe("2026-11-02");

    drive(250); // rest of Nov 2 + seam
    expect(storeState().replaySessionDate).toBe("2026-11-03");

    const candles = result.current.replayCandles!;
    const times = candles.map((c) => c.time);
    expect(new Set(times).size).toBe(times.length);
    expect(times[0]).toBe(dayStartMs("2026-11-01"));
    expect(times[times.length - 1]!).toBeGreaterThanOrEqual(dayStartMs("2026-11-03"));
    expect(storeState().isReplaying).toBe(true);
  });

  it("skips an empty day (weekend) and keeps chaining", () => {
    harness.emptyDays.add("2026-11-02");
    const { result } = mountChain();

    drive(450); // Nov 1 + seam into the empty Nov 2
    drive(30); // empty-day skip + Nov 3 fetch window

    expect(storeState().replaySessionDate).toBe("2026-11-03");
    expect(storeState().isReplaying).toBe(true);

    drive(100); // into Nov 3
    const candles = result.current.replayCandles!;
    const times = candles.map((c) => c.time);
    expect(new Set(times).size).toBe(times.length);
    expect(times[0]).toBe(dayStartMs("2026-11-01"));
    expect(times[times.length - 1]!).toBeGreaterThanOrEqual(dayStartMs("2026-11-03"));
  });
});

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../services/api.ts";
import { useReplaySession } from "../../services/queries.ts";
import type { Candle } from "../../services/schemas.ts";
import { useTradingStore } from "../../services/store.tsx";
import { toLocalDateString } from "../../lib/utils.ts";

type ReplaySessionData = NonNullable<Awaited<ReturnType<typeof api.replayGetSession>>>;
type ReplayTradeEvents = ReplaySessionData["tradeEvents"];
type TickBar = ReplaySessionData["tickBuffer"][number];

/** A replay buffer bar spans one minute. */
const ONE_MINUTE_MS = 60_000;

/** Local-midnight epoch ms of a YYYY-MM-DD date (mirrors replay.ts dayBounds). */
function dayStartMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getTime();
}

/** Map an OpenCharts timeframe string ("15m", "1h", "4h", "1d", "1w") to ms. */
export function timeframeToMs(timeframe: string): number {
  const match = /^(\d+)([smhdw])$/.exec(timeframe);
  if (!match) return ONE_MINUTE_MS;
  const n = Number(match[1]);
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
    match[2] as "s" | "m" | "h" | "d" | "w"
  ];
  return Math.max(ONE_MINUTE_MS, n * (unitMs ?? ONE_MINUTE_MS));
}

/**
 * Aggregate the 1m replay buffer into the chart's timeframe, so replaying on a
 * 15m chart steps through 15m candles (TradingView-style bar replay). Buckets
 * are anchored to the buffer's first bar so every timeframe aligns cleanly.
 */
function aggregateToTimeframe(buf: TickBar[], barMs: number): TickBar[] {
  if (barMs <= ONE_MINUTE_MS) return buf;
  const anchor = buf[0]?.t ?? 0;
  const out: TickBar[] = [];
  let cur: TickBar | null = null;
  for (const b of buf) {
    const bucketStart = anchor + Math.floor((b.t - anchor) / barMs) * barMs;
    if (cur === null || cur.t !== bucketStart) {
      cur = { t: bucketStart, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return out;
}

/** All bars at or before the playback cursor, as chart candles.
 *
 * While the cursor sits inside a bar, that bar is presented as a forming
 * candle whose close has walked proportionally from its open toward its close
 * (high/low stay final — the buffer has no intra-bar path). Without this the
 * chart would sit still between bar boundaries, which reads as
 * "replay is not playing".
 */
function sliceBufferToCursor(buf: TickBar[], cursorMs: number | null, barMs: number): Candle[] {
  const cutoff = cursorMs ?? buf[0]?.t ?? 0;
  const out: Candle[] = [];
  let lastBarMs: number | null = null;
  for (const b of buf) {
    if (b.t > cutoff) break;
    lastBarMs = b.t;
    out.push({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
  }
  const last = out[out.length - 1];
  if (cursorMs != null && last && lastBarMs != null) {
    const progress = Math.min(1, Math.max(0, (cursorMs - lastBarMs) / barMs));
    if (progress < 1) {
      out[out.length - 1] = {
        ...last,
        close: last.open + (last.close - last.open) * progress,
      };
    }
  }
  return out;
}

/**
 * Bridges a replay session into chart-ready data.
 *
 * - Focuses the chart on the session's primary symbol when replay starts.
 * - Slices the 1m tick buffer up to the playback cursor, so the chart reveals
 *   bars progressively as `useReplayPlayback` advances the cursor.
 * - Chains days: bars of days already played are accumulated as raw 1m bars,
 *   so a multi-day replay reads as one continuous series.
 *
 * While `replayCandles` is non-null the caller must suppress the live feed
 * (tick / liveCandle props) so real-time data can't paint over the playback.
 */
export function useReplayChartData(
  accountId: string | null,
  timeframe: string,
): {
  replayCandles: Candle[] | null;
  replayTradeEvents: ReplayTradeEvents | undefined;
} {
  const isReplaying = useTradingStore((s) => s.isReplaying);
  const replaySessionDate = useTradingStore((s) => s.replaySessionDate);
  const replayCursorTimestamp = useTradingStore((s) => s.replayCursorTimestamp);
  const setSelectedSymbol = useTradingStore((s) => s.setSelectedSymbol);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);

  const { data } = useReplaySession(
    isReplaying ? accountId : null,
    replaySessionDate,
    selectedSymbol,
  );

  // Focus the chart on the replayed symbol once the session loads.
  const replaySymbol = isReplaying ? (data?.meta?.primarySymbol ?? null) : null;
  useEffect(() => {
    if (replaySymbol) setSelectedSymbol(replaySymbol);
  }, [replaySymbol, setSelectedSymbol]);

  // ── Multi-day accumulation ───────────────────────────────
  // Replay chains day after day (useReplayPlayback advances the session date
  // at each day's end). Raw 1m bars of days already played are folded in
  // here, so the chart builds one continuous series across days instead of
  // restarting at every seam — which also keeps cross-day timeframe buckets
  // (1w especially) aligned to a single anchor.
  const [accumulated, setAccumulated] = useState<TickBar[]>([]);
  const accDateRef = useRef<string | null>(null);
  const prevDayBufRef = useRef<{ date: string; buf: TickBar[] } | null>(null);

  // Remember the loaded session day's buffer, labelled by its own first-bar
  // date — during the day-advance fetch `data` still holds the old day.
  useLayoutEffect(() => {
    const buf = data?.tickBuffer;
    if (!buf || buf.length === 0) return;
    prevDayBufRef.current = { date: toLocalDateString(new Date(buf[0]!.t)), buf };
  }, [data]);

  // When the session advances to the next day, fold the consumed day's raw
  // bars into the accumulation; a brand-new session (re)starts from zero.
  useLayoutEffect(() => {
    if (!isReplaying || !replaySessionDate) {
      if (accDateRef.current !== null) {
        accDateRef.current = null;
        prevDayBufRef.current = null;
        setAccumulated([]);
      }
      return;
    }
    if (accDateRef.current === null) {
      accDateRef.current = replaySessionDate;
      return;
    }
    if (accDateRef.current === replaySessionDate) return;
    const prev = prevDayBufRef.current;
    if (prev && prev.date === accDateRef.current && prev.buf.length > 0) {
      // Keep bars strictly before the new day's start: the dayBounds windows
      // of consecutive days can overlap around DST transitions, and duplicate
      // timestamps would corrupt the aggregated series.
      const seam = dayStartMs(replaySessionDate);
      setAccumulated((acc) => acc.concat(prev.buf.filter((b) => b.t < seam)));
    }
    accDateRef.current = replaySessionDate;
  }, [isReplaying, replaySessionDate]);

  // Progressive reveal: accumulated raw bars (days already played) plus the
  // current session day's buffer, sliced at the playback cursor and aggregated
  // into the chart's timeframe so replay steps one chart candle at a time.
  // While the next day loads, `data` is undefined (or still the previous
  // day's buffer) — only bars belonging to the current session date are taken
  // from it, so the already-played days keep the chart filled at the seam.
  const replayCandles = useMemo<Candle[] | null>(() => {
    if (!isReplaying) return null;
    const barMs = timeframeToMs(timeframe);
    const dayStart = replaySessionDate ? dayStartMs(replaySessionDate) : 0;
    const currentDayBars = (data?.tickBuffer ?? []).filter((b) => b.t >= dayStart);
    const raw = accumulated.concat(currentDayBars);
    if (raw.length === 0) return null;
    const aggregated = aggregateToTimeframe(raw, barMs);
    return sliceBufferToCursor(aggregated, replayCursorTimestamp, barMs);
  }, [isReplaying, data, accumulated, replayCursorTimestamp, timeframe, replaySessionDate]);

  return {
    replayCandles,
    replayTradeEvents: isReplaying ? data?.tradeEvents : undefined,
  };
}

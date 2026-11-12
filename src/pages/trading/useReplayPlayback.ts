import { useEffect, useRef } from "react";
import { useTradingStore } from "../../services/store.tsx";
import { useReplaySession } from "../../services/queries.ts";
import { api } from "../../services/api.ts";
import { nextLocalDateString, toLocalDateString } from "../../lib/utils.ts";
import { toast } from "../../services/toast.ts";

/**
 * Maximum candles advanced per rAF frame when catching up (e.g. after seek).
 * Prevents blocking the main thread on high-speed or large-jump scenarios.
 */
const MAX_TICKS_PER_FRAME = 10;

/** How often to push replayCursorTimestamp to the Zustand store (ms). */
const STORE_SYNC_MS = 250;

/** How often to PATCH the server with the current cursor position (ms). */
const SERVER_SYNC_MS = 2000;

/**
 * How long a day-advance may wait for the next day's buffer before giving up
 * and stopping the replay (adapter offline, symbol gone, etc.).
 */
const DAY_ADVANCE_GIVE_UP_MS = 15_000;

type TickBar = { t: number; o: number; h: number; l: number; c: number; v: number };

type MutableRef<T> = { current: T };

/** Advance the tick index up to the cursor, chunked to MAX_TICKS_PER_FRAME. */
function advanceTickIndex(buf: TickBar[], idxRef: MutableRef<number>, cursorMs: number): void {
  let chunk = 0;
  while (
    idxRef.current < buf.length &&
    (buf[idxRef.current]?.t ?? Infinity) <= cursorMs &&
    chunk < MAX_TICKS_PER_FRAME
  ) {
    idxRef.current++;
    chunk++;
  }
}

/** Throttled store write (drives scrubber + HUD timestamp). */
function syncCursorToStore(now: number, lastSyncRef: MutableRef<number>, cursorMs: number): void {
  if (now - lastSyncRef.current < STORE_SYNC_MS) return;
  useTradingStore.setState({ replayCursorTimestamp: cursorMs });
  lastSyncRef.current = now;
}

/** Throttled server PATCH so the cursor survives a reload. */
function syncCursorToServer(
  now: number,
  lastSyncRef: MutableRef<number>,
  accountId: string,
  sessionDate: string | null,
  cursorMs: number,
): void {
  if (now - lastSyncRef.current < SERVER_SYNC_MS || !sessionDate) return;
  lastSyncRef.current = now;
  api
    .replayPatchSession(accountId, { sessionDate, cursorTimestamp: cursorMs })
    .catch(() => null);
}

/**
 * End-of-buffer transition: pin the cursor, stop the server session (so it
 * doesn't sit in PLAYING until the TTL reaper catches it) and flip the store.
 */
function finishReplay(accountId: string, sessionDate: string | null, endMs: number): void {
  useTradingStore.setState({ replayCursorTimestamp: endMs });
  if (sessionDate) {
    api.replayStop(accountId, sessionDate).catch(() => null);
  }
  useTradingStore.getState().onReplayStateChanged("stopped");
}

/**
 * Drives the client-side replay clock using requestAnimationFrame.
 *
 * - Advances replayCursorTimestamp at replaySpeed chart-bars per real second,
 *   regardless of the charted timeframe (TradingView-style bar replay): 1x
 *   reveals one new candle every second, 2x two candles, and so on.
 * - Throttles Zustand writes to STORE_SYNC_MS to avoid per-frame re-renders.
 * - Debounces server PATCH to SERVER_SYNC_MS for cursor persistence.
 * - Advances up to MAX_TICKS_PER_FRAME tick indices per frame (chunked).
 * - Detects external seeks by comparing store cursor to local cursor ref.
 * - Chains into the next calendar day at each day's end (TradingView-style
 *   multi-day replay) and only auto-stops at today's live edge.
 */
export function useReplayPlayback(accountId: string, replayBarMs: number) {
  const isReplaying = useTradingStore((s) => s.isReplaying);
  const replayPaused = useTradingStore((s) => s.replayPaused);
  const replaySpeed = useTradingStore((s) => s.replaySpeed);
  const replayCursorTimestamp = useTradingStore((s) => s.replayCursorTimestamp);
  const replaySessionDate = useTradingStore((s) => s.replaySessionDate);

  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const { data: sessionData } = useReplaySession(
    isReplaying ? accountId : null,
    replaySessionDate,
    selectedSymbol,
  );

  // ── Stable refs (no re-render on change) ────────────────
  const speedRef = useRef(replaySpeed);
  const sessionDateRef = useRef(replaySessionDate);
  const tickBufferRef = useRef<TickBar[]>([]);
  const nextTickIdxRef = useRef(0);
  const localCursorMsRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const lastStoreSyncRef = useRef(0);
  const lastServerSyncRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const isActiveRef = useRef(false);
  /** Non-null while holding at a day seam, waiting for the next day's buffer. */
  const dayAdvanceRef = useRef<{ awaitedDate: string; startedAt: number } | null>(null);

  // Keep speed + sessionDate refs current without restarting the loop
  useEffect(() => {
    speedRef.current = replaySpeed;
  }, [replaySpeed]);
  useEffect(() => {
    sessionDateRef.current = replaySessionDate;
  }, [replaySessionDate]);
  const barMsRef = useRef(replayBarMs);
  useEffect(() => {
    barMsRef.current = replayBarMs;
  }, [replayBarMs]);

  // Reset playback position whenever a replay session (re)starts. Without this
  // the local cursor/index refs survive a stop, so replaying the same day
  // resumed from the previous end-of-buffer and auto-stopped immediately.
  useEffect(() => {
    if (isReplaying) {
      localCursorMsRef.current = null;
      nextTickIdxRef.current = 0;
      dayAdvanceRef.current = null;
    }
  }, [isReplaying]);

  // Sync tick buffer ref when session data loads. This effect also drives the
  // multi-day chain: the tick index is recomputed from the local cursor (a
  // day-advance pins the cursor at the previous day's end, which lands at the
  // start of the new buffer), the day-advance hold is released once the
  // awaited day actually arrives, and calendar days with no 1m history at all
  // are skipped instead of stalling into the give-up timer.
  useEffect(() => {
    if (!isReplaying || !sessionData) return;
    const buf = sessionData.tickBuffer;
    const pending = dayAdvanceRef.current;

    if (buf.length === 0) {
      if (pending && pending.awaitedDate < toLocalDateString()) {
        // The awaited day has no bars (weekend / holiday / outage) — skip
        // straight to the next calendar day.
        const nextDate = nextLocalDateString(pending.awaitedDate);
        dayAdvanceRef.current = { awaitedDate: nextDate, startedAt: Date.now() };
        sessionDateRef.current = nextDate;
        useTradingStore.getState().setReplaySessionDate(nextDate);
      } else if (!pending && localCursorMsRef.current === null) {
        // Fresh session on a day with no data — stop and say why instead of
        // idling with a frozen HUD.
        toast.warning(
          "Replay unavailable",
          sessionData.meta?.primarySymbol
            ? `No 1m candle history stored for ${sessionData.meta.primarySymbol} on ${sessionData.replaySession.sessionDate}`
            : `No trading activity found on ${sessionData.replaySession.sessionDate}`,
        );
        api.replayStop(accountId, sessionData.replaySession.sessionDate).catch(() => null);
        useTradingStore.getState().onReplayStateChanged("stopped");
      }
      return;
    }

    tickBufferRef.current = buf;
    const cursor = localCursorMsRef.current;
    if (cursor != null) {
      let idx = 0;
      while (idx < buf.length && (buf[idx]?.t ?? Infinity) <= cursor) idx++;
      nextTickIdxRef.current = idx;
    } else {
      nextTickIdxRef.current = 0;
    }
    // Release the hold only when the buffer really is the awaited day — a
    // refetch of the previous day must not unpause the seam.
    if (pending && toLocalDateString(new Date(buf[0]!.t)) === pending.awaitedDate) {
      dayAdvanceRef.current = null;
    }
  }, [isReplaying, sessionData, accountId]);

  // Detect external seeks: if the store cursor diverges from our local cursor
  // by more than 1s, accept the new position and recompute the tick index.
  useEffect(() => {
    if (replayCursorTimestamp == null) return;
    const local = localCursorMsRef.current;
    if (local == null || Math.abs(replayCursorTimestamp - local) > 1000) {
      localCursorMsRef.current = replayCursorTimestamp;
      // Recompute tick index after seek
      const buf = tickBufferRef.current;
      let idx = 0;
      while (idx < buf.length && (buf[idx]?.t ?? Infinity) <= replayCursorTimestamp) idx++;
      nextTickIdxRef.current = idx;
    }
  }, [replayCursorTimestamp]);

  // ── rAF playback loop ────────────────────────────────────
  useEffect(() => {
    if (!isReplaying || replayPaused) {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      lastFrameTimeRef.current = null;
      return;
    }

    isActiveRef.current = true;
    lastFrameTimeRef.current = null;

    // One playback step; returns false when the loop must stop scheduling.
    const step = (now: number): boolean => {
      // Bootstrap frame time on first tick after play/resume
      if (lastFrameTimeRef.current === null) {
        lastFrameTimeRef.current = now;
        return true;
      }

      // Holding at a day seam while the next day's buffer loads: keep the
      // cursor pinned and the frame clock fresh, but advance nothing. Give up
      // (and stop the replay) if the next day never arrives.
      const pendingAdvance = dayAdvanceRef.current;
      if (pendingAdvance) {
        lastFrameTimeRef.current = now;
        if (Date.now() - pendingAdvance.startedAt > DAY_ADVANCE_GIVE_UP_MS) {
          dayAdvanceRef.current = null;
          isActiveRef.current = false;
          finishReplay(accountId, pendingAdvance.awaitedDate, localCursorMsRef.current ?? 0);
          return false;
        }
        return true;
      }

      // Cap real delta to 100ms to handle tab-switch gaps gracefully
      const realDeltaMs = Math.min(now - lastFrameTimeRef.current, 100);
      lastFrameTimeRef.current = now;
      // replaySpeed chart bars per real second: one bar of replayBarMs market
      // time per (1000 / speed) ms of real time.
      const replayDeltaMs = realDeltaMs * speedRef.current * (barMsRef.current / 1000);

      const buf = tickBufferRef.current;
      if (buf.length === 0) return true; // session data still loading

      const endMs = buf[buf.length - 1]!.t;
      // Initialise cursor to buffer start on the first frame of a session
      const prevCursorMs = localCursorMsRef.current ?? buf[0]!.t;
      const newCursorMs = Math.min(prevCursorMs + replayDeltaMs, endMs);
      localCursorMsRef.current = newCursorMs;

      advanceTickIndex(buf, nextTickIdxRef, newCursorMs);
      syncCursorToStore(now, lastStoreSyncRef, newCursorMs);
      syncCursorToServer(now, lastServerSyncRef, accountId, sessionDateRef.current, newCursorMs);

      // End of buffer: chain into the next calendar day (TradingView-style
      // multi-day replay), or stop for good when today's live edge is reached.
      if (newCursorMs >= endMs) {
        const currentDate = sessionDateRef.current;
        if (currentDate && currentDate < toLocalDateString()) {
          const nextDate = nextLocalDateString(currentDate);
          dayAdvanceRef.current = { awaitedDate: nextDate, startedAt: Date.now() };
          sessionDateRef.current = nextDate;
          localCursorMsRef.current = endMs; // hold at the day seam
          useTradingStore.getState().setReplaySessionDate(nextDate);
          return true;
        }
        isActiveRef.current = false;
        finishReplay(accountId, currentDate, endMs);
        return false;
      }
      return true;
    };

    const frame = (now: number) => {
      if (!isActiveRef.current) return;
      if (step(now)) rafIdRef.current = requestAnimationFrame(frame);
    };

    rafIdRef.current = requestAnimationFrame(frame);

    return () => {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isReplaying, replayPaused, accountId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);
}

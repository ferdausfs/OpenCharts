import { useCallback, useEffect, useRef, useState } from "react";
import { useTradingStore } from "../../services/store.tsx";
import { useReplaySession } from "../../services/queries.ts";
import { api } from "../../services/api.ts";

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Debounce for the server seek while the user drags (ms). */
const SEEK_DEBOUNCE_MS = 400;
/** How long the optimistic thumb override survives after the last move (ms). */
const DRAG_HOLD_MS = 700;

export function ReplayScrubber({ accountId }: { accountId: string }) {
  // Narrow selectors — subscribing to the whole store re-rendered this strip
  // on every tick flush (audit #19).
  const replayCursorTimestamp = useTradingStore((s) => s.replayCursorTimestamp);
  const replaySessionDate = useTradingStore((s) => s.replaySessionDate);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const { data } = useReplaySession(accountId, replaySessionDate, selectedSymbol);

  const barRef = useRef<HTMLDivElement>(null);

  // Optimistic thumb (audit #9): while dragging, follow the pointer instantly.
  // The server previously received a PATCH per pointermove, and each response
  // bumped replayVersion → full candle refetch + setData — scrubbing felt
  // laggy and jumpy.
  const [dragMs, setDragMs] = useState<number | null>(null);
  const dragHoldTimer = useRef<number | null>(null);
  const seekTimer = useRef<number | null>(null);
  const lastSentTs = useRef<string | null>(null);

  const tickBuffer = data?.tickBuffer ?? [];
  const tradeEvents = data?.tradeEvents ?? [];
  const sessionDate = replaySessionDate;

  const startMs = tickBuffer[0]?.t ?? null;
  const endMs = tickBuffer[tickBuffer.length - 1]?.t ?? null;
  const rangeMs = startMs != null && endMs != null ? endMs - startMs : 0;

  const shownTs = dragMs ?? replayCursorTimestamp;
  const thumbPct =
    shownTs != null && startMs != null && rangeMs > 0
      ? Math.max(0, Math.min(100, ((shownTs - startMs) / rangeMs) * 100))
      : null;

  // Clear pending timers on unmount.
  useEffect(() => {
    return () => {
      if (dragHoldTimer.current !== null) window.clearTimeout(dragHoldTimer.current);
      if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    };
  }, []);

  const seekToX = useCallback(
    (clientX: number) => {
      if (!barRef.current || !sessionDate || startMs == null || rangeMs <= 0) return;
      const rect = barRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const tsMs = startMs + pct * rangeMs;

      setDragMs(tsMs);
      if (dragHoldTimer.current !== null) window.clearTimeout(dragHoldTimer.current);
      dragHoldTimer.current = window.setTimeout(() => setDragMs(null), DRAG_HOLD_MS);

      // One seek per pause, not per pixel.
      if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
      seekTimer.current = window.setTimeout(() => {
        const ts = new Date(tsMs).toISOString();
        if (ts === lastSentTs.current) return;
        lastSentTs.current = ts;
        api.replaySeek(accountId, sessionDate, ts).catch(() => null);
      }, SEEK_DEBOUNCE_MS);
    },
    [accountId, sessionDate, startMs, rangeMs],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      seekToX(e.clientX);
    },
    [seekToX],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1) return;
      seekToX(e.clientX);
    },
    [seekToX],
  );

  if (!replaySessionDate || tickBuffer.length === 0) return null;

  return (
    <div className="h-7 px-3 flex items-center gap-2 bg-card border-t border-border shrink-0 select-none">
      {/* Start time label */}
      {startMs != null && (
        <span className="text-[10px] text-muted-foreground font-mono tabular-nums shrink-0">
          {formatTime(startMs)}
        </span>
      )}

      {/* Track */}
      <div
        ref={barRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        className="relative flex-1 h-1.5 rounded-full bg-secondary cursor-pointer"
      >
        {/* Filled portion */}
        {thumbPct != null && (
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-orange-500/60"
            style={{ width: `${thumbPct}%` }}
          />
        )}

        {/* Trade event markers */}
        {startMs != null &&
          rangeMs > 0 &&
          tradeEvents.map((ev) => {
            const evMs = new Date(ev.timestamp).getTime();
            const pct = ((evMs - startMs) / rangeMs) * 100;
            if (pct < 0 || pct > 100) return null;
            return (
              <div
                key={ev.id}
                title={ev.type === "violation" ? ev.ruleCode : `${ev.type} ${ev.symbolName ?? ""}`}
                className={`absolute top-1/2 -translate-y-1/2 w-1 h-1 rounded-full ${
                  ev.type === "violation"
                    ? "bg-red-500"
                    : ev.type === "exit"
                      ? "bg-green-400"
                      : "bg-blue-400"
                }`}
                style={{ left: `${pct}%` }}
              />
            );
          })}

        {/* Thumb */}
        {thumbPct != null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-orange-500 border-2 border-background shadow"
            style={{ left: `${thumbPct}%` }}
          />
        )}
      </div>

      {/* End time label */}
      {endMs != null && (
        <span className="text-[10px] text-muted-foreground font-mono tabular-nums shrink-0">
          {formatTime(endMs)}
        </span>
      )}
    </div>
  );
}

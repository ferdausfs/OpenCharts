import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createDemoAdapter } from "./adapter/demo.ts";
import { OpenChartsProvider } from "./adapter/provider.tsx";
import type { OpenChartsAdapter } from "./adapter/types.ts";
import { chooseAdapter } from "./adapterChoice.ts";
import { wsClient } from "./services/ws.ts";
import { useTradingStore } from "./services/store.tsx";
import { Terminal } from "./terminal/Terminal.tsx";

/**
 * The hosted app's root.
 *
 * Deliberately what an integrator would write: install an adapter, render the
 * terminal. Everything else — query cache, market-data stream, notifications,
 * error boundary — comes from `<OpenChartsProvider>`.
 *
 * Which backend runs is chosen at build time:
 *  - `VITE_ADAPTER=hyperliquid`, or no `VITE_ADAPTER` with `VITE_HL_BUILDER_ADDRESS`
 *    set: the Hyperliquid broker (live markets, real wallet, real orders).
 *  - `VITE_ADAPTER=binance`: the live-market-data example from examples/binance-adapter.
 *  - `VITE_ADAPTER=demo`, or nothing configured: the bundled demo data.
 *
 * The Hyperliquid and Binance code is loaded lazily, so neither reaches the
 * default (demo) bundle.
 */

const choice = chooseAdapter(import.meta.env);

const HyperliquidApp = lazy(() => import("./hyperliquid/ui/HyperliquidApp.tsx"));

function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
      Loading…
    </div>
  );
}

function BinanceOrDemo() {
  const wantsBinance = choice === "binance";
  const [adapter, setAdapter] = useState<OpenChartsAdapter | null>(() =>
    wantsBinance ? null : createDemoAdapter(),
  );

  useEffect(() => {
    if (!wantsBinance) return;
    import("../examples/binance-adapter/binance-adapter.ts")
      .then(({ createBinancePaperAdapter }) => createBinancePaperAdapter())
      .then(setAdapter)
      .catch((err: unknown) => {
        console.error("[opencharts] failed to load the Binance adapter; using the demo", err);
        setAdapter(createDemoAdapter());
      });
  }, [wantsBinance]);

  if (!adapter) return null;
  return (
    <>
      <OpenChartsProvider adapter={adapter}>
        <Terminal />
      </OpenChartsProvider>
      <DebugPanel adapter={adapter} />
    </>
  );
}

// TEMPORARY: on-page diagnostics, shown only when the URL contains ?debug.
// Tells us exactly where candle loading breaks on mobile browsers.
// Remove once the issue is found.
function DebugPanel({ adapter }: { adapter: OpenChartsAdapter }) {
  const [log, setLog] = useState<string[]>(() => [
    `choice=${choice}`,
    `adapter=${adapter.name}`,
  ]);
  const prevStateRef = useRef<string>("");

  const add = (line: string) =>
    setLog((prev) => {
      const next = [...prev, line];
      return next.length > 40 ? next.slice(next.length - 40) : next;
    });

  useEffect(() => {
    let alive = true;
    const addAlive = (line: string) => {
      if (alive) add(line);
    };

    adapter.marketData.onConnectionChange?.((state) => addAlive(`connection=${state}`));

    void (async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(
          "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=5",
        );
        const rows = (await res.json()) as unknown[];
        addAlive(`page fetch: HTTP ${res.status}, rows=${rows.length}, ${Date.now() - t0}ms`);
      } catch (err) {
        addAlive(`page fetch FAILED after ${Date.now() - t0}ms: ${String(err)}`);
      }

      const t1 = Date.now();
      try {
        const candles = await adapter.marketData.getCandles({
          symbol: "BTCUSD",
          timeframe: "15m",
          limit: 500,
        });
        addAlive(`adapter.getCandles: ${candles.length} candles in ${Date.now() - t1}ms`);
      } catch (err) {
        addAlive(`adapter.getCandles FAILED after ${Date.now() - t1}ms: ${String(err)}`);
      }
    })();

    return () => {
      alive = false;
    };
  }, [adapter]);

  // Log every ReplayStateChanged event that reaches the UI layer.
  useEffect(() => {
    const off = wsClient.subscribe("market-data", (event) => {
      const e = event as { eventType?: string; action?: string };
      if (e.eventType === "ReplayStateChanged") {
        add(`[event] ReplayStateChanged action=${e.action ?? "?"}`);
      }
    });
    return off;
  }, []);

  // Poll the trading store; log replay state only when it changes.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useTradingStore.getState();
      const cursor =
        s.replayCursorTimestamp != null ? new Date(s.replayCursorTimestamp).toISOString() : "null";
      const sig = `${s.isReplaying}|${s.replayPaused}|${s.replaySpeed}|${s.replaySessionDate ?? "null"}|${cursor}`;
      if (sig !== prevStateRef.current) {
        prevStateRef.current = sig;
        add(
          `[state] isReplaying=${s.isReplaying} paused=${s.replayPaused} speed=${s.replaySpeed} date=${s.replaySessionDate ?? "null"} cursor=${cursor}`,
        );
      }
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  if (!window.location.search.toLowerCase().includes("debug")) return null;
  return (
    <pre
      style={{
        position: "fixed",
        bottom: 8,
        left: 8,
        right: 8,
        zIndex: 9999,
        background: "rgba(17,24,39,0.95)",
        color: "#fbbf24",
        fontSize: 10,
        lineHeight: 1.4,
        padding: 8,
        borderRadius: 8,
        whiteSpace: "pre-wrap",
        maxHeight: "45%",
        overflow: "auto",
        margin: 0,
      }}
    >
      {log.join("\n")}
    </pre>
  );
}

export function Root() {
  if (choice === "hyperliquid") {
    return (
      <Suspense fallback={<Loading />}>
        <HyperliquidApp />
      </Suspense>
    );
  }
  return <BinanceOrDemo />;
}

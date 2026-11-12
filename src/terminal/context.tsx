import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useIsFeedConnected } from "../components/ConnectionIndicator.tsx";
import {
  TerminalContext,
  TickContext,
  type ConfirmOrderState,
  type TerminalContextValue,
  type TickContextValue,
  useTickFeed,
} from "./use-terminal.ts";
import {
  OrderConfirmDialog,
  OrderModifyDialog,
  PositionModifyDialog,
} from "../components/TradingDialogs.tsx";
import { useChartDrawings } from "../hooks/useChartDrawings.ts";
import {
  getChartPreferencesFromStorage,
  updateChartPreferences,
  useChartPreferences,
} from "../hooks/useChartPreferences.ts";
import { useTradeSound } from "../hooks/useTradeSound.ts";
import { isDarkTheme, subscribeTheme } from "../lib/theme.ts";
import { safeStorage } from "../lib/safe-storage.ts";
import type { IndicatorType } from "../lib/indicators.ts";
import type { CreateJournalEntryInput, UpdateJournalEntryInput } from "../services/api/journal.ts";
import { api } from "../services/api.ts";
import {
  useCancelOrder,
  useCandles,
  useCloseAllPositions,
  useClosePosition,
  useCreateJournalEntry,
  useDeleteJournalEntry,
  useJournalEntries,
  useOrders,
  usePositions,
  useSymbols,
  useUpdateJournalEntry,
} from "../services/queries.ts";
import type { Order, PlaceOrderInput, Position, Symbol } from "../services/schemas.ts";
import { useTradingStore } from "../services/store.tsx";
import { toast } from "../services/toast.ts";
import {
  type DrawingTool,
  type MagnetMode,
  TIMEFRAMES,
  type Timeframe,
} from "../pages/trading/constants.ts";
import { timeframeToMs, useReplayChartData } from "../pages/trading/useReplayChartData.ts";
import { useReplayPlayback } from "../pages/trading/useReplayPlayback.ts";
import { getPipDigits } from "../pages/trading/utils.ts";

/**
 * Shared terminal state.
 *
 * Everything the panels need — the charted symbol and timeframe, candles,
 * drawings, indicators, positions, orders and the actions that change them —
 * lives here rather than in one page component. That is what makes the panels
 * mountable on their own: an application can render just `<Chart />`, or a
 * chart beside its own order form, instead of taking the whole terminal.
 *
 * Layout belongs to whoever composes the panels, so no panel sizes, tab
 * selections or visibility flags are kept here.
 */

/** Stored timeframe for a symbol, or the 15m default. */
function readStoredTimeframe(symbol: string): Timeframe {
  const saved = safeStorage.getItem(`tf_${symbol}`);
  return saved && TIMEFRAMES.includes(saved as Timeframe) ? (saved as Timeframe) : "15m";
}

function getErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: string }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Request failed";
}

/** How many bars to request once the first paint has landed. */
function deepLimitFor(timeframe: Timeframe): number {
  switch (timeframe) {
    case "1m":
      return 3_000;
    case "5m":
      return 5_000;
    case "15m":
      return 6_000;
    case "30m":
      return 8_000;
    case "1h":
      return 8_000;
    case "4h":
      return 4_000;
    case "1d":
      return 2_000;
    case "1w":
      return 520;
    default:
      return 5_000;
  }
}

/**
 * Publishes quotes + the live candle through a separate context so per-tick
 * updates re-render only the quote panels (DOM, order ticket, watchlist) —
 * never the provider tree above the chart.
 */
function TickBridge({
  chartKey,
  selectedSymbol,
  children,
}: {
  chartKey: string;
  selectedSymbol: string;
  children: ReactNode;
}) {
  const ticks = useTradingStore((s) => s.ticks);
  const liveCandleUpdates = useTradingStore((s) => s.liveCandleUpdates);
  const value = useMemo<TickContextValue>(
    () => ({
      ticks,
      tick: ticks[selectedSymbol],
      liveCandle: liveCandleUpdates[chartKey],
    }),
    [ticks, liveCandleUpdates, selectedSymbol, chartKey],
  );
  return <TickContext.Provider value={value}>{children}</TickContext.Provider>;
}

/**
 * Modify / confirm dialogs. They show the live quote while the user edits
 * SL/TP, so they read the quote feed through TickContext — rendered inside
 * <TickBridge> above, which keeps the per-tick re-render confined to this
 * small subtree instead of the whole provider.
 */
function DialogsLayer({
  modifyingPosition,
  modifyingOrder,
  confirmOrder,
  confirmLoading,
  isFeedConnected,
  symbolInfo,
  onClosePosition,
  onCloseOrder,
  onCancelConfirm,
  onConfirmSubmit,
}: {
  modifyingPosition: Position | null;
  modifyingOrder: Order | null;
  confirmOrder: ConfirmOrderState;
  confirmLoading: boolean;
  isFeedConnected: boolean;
  symbolInfo: Symbol | undefined;
  onClosePosition: () => void;
  onCloseOrder: () => void;
  onCancelConfirm: () => void;
  onConfirmSubmit: () => void;
}) {
  const { tick } = useTickFeed();
  return (
    <>
      <PositionModifyDialog
        key={modifyingPosition?.id ?? "no-position"}
        position={modifyingPosition}
        onClose={onClosePosition}
        onSaved={onClosePosition}
        tick={tick}
        isFeedConnected={isFeedConnected}
      />
      <OrderModifyDialog
        key={modifyingOrder?.id ?? "no-order"}
        order={modifyingOrder}
        onClose={onCloseOrder}
        onSaved={onCloseOrder}
        tick={tick}
      />
      <OrderConfirmDialog
        isOpen={!!confirmOrder}
        order={confirmOrder}
        onConfirm={onConfirmSubmit}
        onCancel={onCancelConfirm}
        loading={confirmLoading}
        tick={tick}
        symbolInfo={symbolInfo}
      />
    </>
  );
}

// Stable empties so overlay-off doesn't churn the position-overlay effect
// (audit: fresh [] per render rebuilt price lines every render).
const NO_POSITIONS: Position[] = [];
const NO_ORDERS: Order[] = [];

export function TerminalProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // Narrow selectors — the provider must NOT re-render per WS tick flush, or
  // every panel below it re-renders at tick rate. Quotes flow through
  // <TickBridge> / TickContext instead; ChartPanel paints ticks imperatively.
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useTradingStore((s) => s.setSelectedSymbol);
  const activeAccountId = useTradingStore((s) => s.activeAccountId);
  const replayVersion = useTradingStore((s) => s.replayVersion);
  const isReplaying = useTradingStore((s) => s.isReplaying);
  const updateTick = useTradingStore((s) => s.updateTick);

  // ── Timeframe, held per symbol so switching reads the stored one in render
  const [timeframeBySymbol, setTimeframeBySymbol] = useState<Partial<Record<string, Timeframe>>>(
    {},
  );
  const timeframe: Timeframe =
    timeframeBySymbol[selectedSymbol] ?? readStoredTimeframe(selectedSymbol);
  const setTimeframe = useCallback(
    (tf: Timeframe) => {
      setTimeframeBySymbol((prev) => ({ ...prev, [selectedSymbol]: tf }));
      safeStorage.setItem(`tf_${selectedSymbol}`, tf);
    },
    [selectedSymbol],
  );

  // ── Chart configuration
  const chartPrefs = useChartPreferences();
  const [activeIndicators, setActiveIndicators] = useState<IndicatorType[]>([]);
  const toggleIndicator = useCallback((type: IndicatorType) => {
    setActiveIndicators((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }, []);
  const clearIndicators = useCallback(() => setActiveIndicators([]), []);

  const [activePlugins, setActivePlugins] = useState<string[]>(
    () => getChartPreferencesFromStorage().activePlugins,
  );
  const togglePlugin = useCallback((id: string) => {
    setActivePlugins((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      updateChartPreferences({ activePlugins: next });
      return next;
    });
  }, []);
  const setPlugins = useCallback((ids: string[]) => {
    setActivePlugins(ids);
    updateChartPreferences({ activePlugins: ids });
  }, []);
  const cycleMagnetMode = useCallback(() => {
    const order: MagnetMode[] = ["none", "weak", "strong"];
    const next = order[(order.indexOf(chartPrefs.magnetMode) + 1) % order.length] ?? "none";
    updateChartPreferences({ magnetMode: next });
  }, [chartPrefs.magnetMode]);

  // ── Drawings
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("none");
  const {
    drawings,
    addDrawing,
    updateDrawing,
    removeDrawing,
    clearDrawings,
    undo: undoDrawing,
    redo: redoDrawing,
  } = useChartDrawings(selectedSymbol, timeframe);

  // ── Trading preferences
  const [oneClick, setOneClick] = useState(
    () => safeStorage.getItem("oneClickTrading") === "true",
  );
  const toggleOneClick = useCallback(() => {
    setOneClick((prev) => {
      const next = !prev;
      safeStorage.setItem("oneClickTrading", String(next));
      return next;
    });
  }, []);
  const { muted: soundMuted, toggleMute: toggleSoundMute, playTradeSound } = useTradeSound();

  // No analytics: a library must not ship telemetry into the host's bundle.
  // Hosts that want to track fills can listen for "order.filled" on their own
  // adapter's trading.subscribe().
  const onOrderSuccess = useCallback(() => {
    playTradeSound();
  }, [playTradeSound]);

  // ── Dialogs, owned here so any composition of panels gets them
  const [modifyingPosition, setModifyingPosition] = useState<Position | null>(null);
  const [modifyingOrder, setModifyingOrder] = useState<Order | null>(null);
  const [confirmOrder, setConfirmOrder] = useState<ConfirmOrderState>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const { data: symbols = [] } = useSymbols();
  const isFeedConnected = useIsFeedConnected();

  // Prime the active symbol with a fresh snapshot on switch so bid/ask appears
  // without waiting for the next tick.
  useEffect(() => {
    let cancelled = false;
    void api
      .getTick(selectedSymbol)
      .then((snapshot) => {
        if (cancelled || !snapshot) return;
        updateTick(
          selectedSymbol,
          Number(snapshot.bid),
          Number(snapshot.ask),
          typeof snapshot.timestamp === "number" ? snapshot.timestamp : Date.now(),
        );
      })
      .catch(() => {
        // Ignore snapshot misses; the stream remains authoritative.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, updateTick]);

  const invalidateTrading = useCallback(() => {
    if (!activeAccountId) return;
    queryClient.invalidateQueries({ queryKey: ["orders", activeAccountId] });
    queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
  }, [activeAccountId, queryClient]);

  // Single submit path for the flows that bypass the usePlaceOrder mutation.
  // Toasts the reason and rethrows so callers can skip their success effects.
  const submitOrderDirect = useCallback(
    async (input: PlaceOrderInput) => {
      try {
        const order = await api.placeOrder(input);
        invalidateTrading();
        return order;
      } catch (err) {
        toast.error("Order Failed", getErrorMessage(err));
        throw err;
      }
    },
    [invalidateTrading],
  );

  const modifyPositionLevels = useCallback(
    async (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) => {
      if (!isFeedConnected) {
        toast.warning(
          "No Data Feed",
          "Cannot modify positions while disconnected from the data feed",
        );
        invalidateTrading();
        return;
      }
      try {
        await api.modifyPosition(positionId, mods);
        const field = mods.takeProfit !== undefined ? "TP" : "SL";
        const price = mods.takeProfit !== undefined ? mods.takeProfit : mods.stopLoss;
        toast.success(`${field} Updated`, `${field} set to ${price}`);
        invalidateTrading();
      } catch (err) {
        toast.error("Modify Failed", getErrorMessage(err));
        invalidateTrading();
      }
    },
    [invalidateTrading, isFeedConnected],
  );

  // Chart context-menu orders always route through the confirm dialog, so a
  // stray right-click can never place one directly.
  const quickOrder = useCallback(
    (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => {
      if (!activeAccountId) {
        toast.warning("No Account", "Select an account before placing orders");
        return;
      }
      const input: PlaceOrderInput = {
        accountId: activeAccountId,
        symbol: selectedSymbol,
        side,
        type,
        quantity: 1,
        ...(type === "LIMIT" ? { price } : { stopPrice: price }),
      };
      setConfirmOrder({ ...input, _submit: () => submitOrderDirect(input) });
    },
    [activeAccountId, selectedSymbol, submitOrderDirect],
  );

  // ── Candles: small first paint, deeper history a beat later
  const chartKey = `${selectedSymbol}:${timeframe}`;
  const firstPaintCandleLimit = useMemo(
    () => (typeof window !== "undefined" && window.innerWidth < 768 ? 500 : 400),
    [],
  );
  // Remember deepened symbol:tf pairs for the session (audit #7): revisiting a
  // timeframe must not replay the shallow-first-paint → 400ms → deep-fetch
  // sequence, which re-jumped the chart every time you switched back.
  const [deepenedKeys, setDeepenedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const isDeepened = deepenedKeys.has(chartKey);
  const candleLimit = isDeepened ? deepLimitFor(timeframe) : firstPaintCandleLimit;
  useEffect(() => {
    if (isDeepened) return;
    const timer = window.setTimeout(() => {
      setDeepenedKeys((prev) => {
        if (prev.has(chartKey)) return prev;
        const next = new Set(prev);
        next.add(chartKey);
        return next;
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [chartKey, isDeepened]);

  const { data: candles = [] } = useCandles(selectedSymbol, timeframe, candleLimit, replayVersion);
  const { replayCandles, replayTradeEvents } = useReplayChartData(activeAccountId, timeframe);
  useReplayPlayback(activeAccountId ?? "", timeframeToMs(timeframe));

  const { data: positions = [] } = usePositions(activeAccountId);
  const { data: orders = [] } = useOrders(activeAccountId);
  const positionPnl = useMemo(
    () => positions.reduce((sum, position) => sum + (position.unrealizedPnl || 0), 0),
    [positions],
  );
  const chartPositions = chartPrefs.overlayPositionsOnChart ? positions : NO_POSITIONS;
  const chartOrders = chartPrefs.overlayPositionsOnChart ? orders : NO_ORDERS;

  const { data: journalData, isLoading: journalLoading } = useJournalEntries(activeAccountId);
  const createJournalMutation = useCreateJournalEntry();
  const updateJournalMutation = useUpdateJournalEntry();
  const deleteJournalMutation = useDeleteJournalEntry();

  const createJournal = useCallback(
    (data: CreateJournalEntryInput) =>
      createJournalMutation.mutate(data, {
        onSuccess: () => toast.success("Journal", "Entry saved"),
        onError: (err: unknown) => toast.error("Journal", getErrorMessage(err)),
      }),
    [createJournalMutation],
  );
  const updateJournal = useCallback(
    (id: string, data: UpdateJournalEntryInput) =>
      updateJournalMutation.mutate(
        { id, accountId: activeAccountId ?? "", ...data },
        {
          onSuccess: () => toast.success("Journal", "Entry updated"),
          onError: (err: unknown) => toast.error("Journal", getErrorMessage(err)),
        },
      ),
    [activeAccountId, updateJournalMutation],
  );
  const deleteJournal = useCallback(
    (id: string) =>
      deleteJournalMutation.mutate(
        { id, accountId: activeAccountId ?? "" },
        {
          onSuccess: () => toast.success("Journal", "Entry deleted"),
          onError: (err: unknown) => toast.error("Journal", getErrorMessage(err)),
        },
      ),
    [activeAccountId, deleteJournalMutation],
  );

  // ── Position and order actions, so a standalone table can act on its own
  const closePositionMutation = useClosePosition();
  const closeAllMutation = useCloseAllPositions();
  const cancelOrderMutation = useCancelOrder();

  const requireTradingReady = useCallback((): string | null => {
    if (!activeAccountId) {
      toast.warning("No Account", "Select an account first");
      return null;
    }
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot trade while disconnected from the data feed");
      return null;
    }
    return activeAccountId;
  }, [activeAccountId, isFeedConnected]);

  const closePosition = useCallback(
    (positionId: string, quantity?: number) => {
      const accountId = requireTradingReady();
      if (!accountId || closePositionMutation.isPending) return;
      closePositionMutation.mutate(
        { positionId, accountId, ...(quantity != null ? { quantity } : {}) },
        {
          onSuccess: () =>
            toast.success(
              quantity != null ? "Partial Close" : "Position Closed",
              quantity != null ? `Closed ${quantity} lot(s)` : "Position has been closed",
            ),
          onError: (err: unknown) => toast.error("Close Failed", getErrorMessage(err)),
        },
      );
    },
    [closePositionMutation, requireTradingReady],
  );

  const closeAllPositions = useCallback(() => {
    const accountId = requireTradingReady();
    if (!accountId || closeAllMutation.isPending) return;
    closeAllMutation.mutate(accountId, {
      onSuccess: () => toast.success("Positions Closed", "All positions have been closed"),
      onError: (err: unknown) => toast.error("Close All Failed", getErrorMessage(err)),
    });
  }, [closeAllMutation, requireTradingReady]);

  const cancelOrder = useCallback(
    (orderId: string) => {
      const accountId = requireTradingReady();
      if (!accountId || cancelOrderMutation.isPending) return;
      cancelOrderMutation.mutate(
        { orderId, accountId },
        {
          onSuccess: () => toast.info("Order Cancelled", "Pending order has been cancelled"),
          onError: (err: unknown) => toast.error("Cancel Failed", getErrorMessage(err)),
        },
      );
    },
    [cancelOrderMutation, requireTradingReady],
  );

  const account = useTradingStore((s) => s.accounts.find((a) => a.id === activeAccountId));
  const symbolInfo = symbols.find((s) => s.name === selectedSymbol) as Symbol | undefined;
  const pipDigits = useMemo(
    () => getPipDigits(symbolInfo, selectedSymbol),
    [symbolInfo, selectedSymbol],
  );
  // Reactive theme: re-renders on toggle instead of reading documentElement
  // once per render (that made isDark effectively frozen between switches).
  const isDark = useSyncExternalStore(subscribeTheme, isDarkTheme, () => true);

  // Memoised so the identity only changes when something in it actually
  // changes — without this, every render of the provider re-rendered the
  // whole terminal tree (TradingPage, toolbar, panels, dialogs) even when
  // nothing the context carries had changed.
  const value: TerminalContextValue = useMemo(
    () => ({
      selectedSymbol,
      setSelectedSymbol,
      symbols,
      symbolInfo,
      pipDigits,
      isDark,

      timeframe,
      setTimeframe,

      candles,
      replayCandles,
      replayTradeEvents,
      isReplaying,

      chartPrefs,
      activeIndicators,
      toggleIndicator,
      clearIndicators,
      activePlugins,
      togglePlugin,
      setPlugins,
      cycleMagnetMode,

      drawingTool,
      setDrawingTool,
      drawings,
      addDrawing,
      updateDrawing,
      removeDrawing,
      clearDrawings,
      undoDrawing,
      redoDrawing,

      activeAccountId,
      account,
      positions,
      orders,
      positionPnl,
      chartPositions,
      chartOrders,
      isFeedConnected,

      oneClick,
      toggleOneClick,
      soundMuted,
      toggleSoundMute,
      onOrderSuccess,
      requestOrderConfirmation: setConfirmOrder,
      submitOrderDirect,
      quickOrder,
      modifyPositionLevels,
      editPosition: setModifyingPosition,
      editOrder: setModifyingOrder,
      closePosition,
      closeAllPositions,
      cancelOrder,

      journalEntries: (journalData?.entries ?? []) as TerminalContextValue["journalEntries"],
      journalLoading,
      createJournal,
      updateJournal,
      deleteJournal,
    }),
    [
      selectedSymbol,
      setSelectedSymbol,
      symbols,
      symbolInfo,
      pipDigits,
      isDark,
      timeframe,
      setTimeframe,
      candles,
      replayCandles,
      replayTradeEvents,
      isReplaying,
      chartPrefs,
      activeIndicators,
      toggleIndicator,
      clearIndicators,
      activePlugins,
      togglePlugin,
      setPlugins,
      cycleMagnetMode,
      drawingTool,
      setDrawingTool,
      drawings,
      addDrawing,
      updateDrawing,
      removeDrawing,
      clearDrawings,
      undoDrawing,
      redoDrawing,
      activeAccountId,
      account,
      positions,
      orders,
      positionPnl,
      chartPositions,
      chartOrders,
      isFeedConnected,
      setConfirmOrder,
      setModifyingPosition,
      setModifyingOrder,
      oneClick,
      toggleOneClick,
      soundMuted,
      toggleSoundMute,
      onOrderSuccess,
      submitOrderDirect,
      quickOrder,
      modifyPositionLevels,
      closePosition,
      closeAllPositions,
      cancelOrder,
      journalData,
      journalLoading,
      createJournal,
      updateJournal,
      deleteJournal,
    ],
  );

  return (
    <TerminalContext.Provider value={value}>
      <TickBridge chartKey={chartKey} selectedSymbol={selectedSymbol}>
        {children}
        {/* Dialogs live with the state so any composition of panels gets them.
            They render inside <TickBridge> because they display the live quote
            while the user edits SL/TP — see <DialogsLayer> above. */}
        <DialogsLayer
          modifyingPosition={modifyingPosition}
          modifyingOrder={modifyingOrder}
          confirmOrder={confirmOrder}
          confirmLoading={confirmLoading}
          isFeedConnected={isFeedConnected}
          symbolInfo={symbolInfo}
          onClosePosition={() => setModifyingPosition(null)}
          onCloseOrder={() => setModifyingOrder(null)}
          onCancelConfirm={() => setConfirmOrder(null)}
          onConfirmSubmit={() => {
            if (!confirmOrder?._submit) return;
            setConfirmLoading(true);
            confirmOrder
              ._submit()
              .then(() => onOrderSuccess())
              .catch(() => {
                // Submit paths toast their own reason; swallow so the rejection
                // never escapes as an unhandled promise.
              })
              .finally(() => {
                setConfirmLoading(false);
                setConfirmOrder(null);
              });
          }}
        />
      </TickBridge>
    </TerminalContext.Provider>
  );
}

import { useCallback, useRef, useState } from "react";
import { MobileAccountBar, MobileTradingPanel } from "../components/MobileTradingPanel.tsx";
import { NewsFeed as MarketNewsFeed } from "../components/TradingPowerFeatures.tsx";
import { ConnectionIndicator } from "../components/ConnectionIndicator.tsx";
import { TradingViewTechnicalAnalysis } from "../components/TradingViewWidgets.tsx";
import type { IndicatorType } from "../lib/indicators.ts";
import { safeStorage } from "../lib/safe-storage.ts";
import type { PlaceOrderInput } from "../services/schemas.ts";
import { updateChartPreferences } from "../hooks/useChartPreferences.ts";
import { useTerminal } from "../terminal/use-terminal.ts";
import { BottomPanel } from "./trading/BottomPanel.tsx";
import { ChartPanel } from "./trading/ChartPanel.tsx";
import { ChartToolbar } from "./trading/ChartToolbar.tsx";
import { REPLAY_ENABLED } from "./trading/constants.ts";
import { DOMPanel } from "./trading/DOMPanel.tsx";
import { MarketClosedBanner } from "./trading/MarketClosedBanner.tsx";
import { OrderPanel } from "./trading/OrderPanel.tsx";
import { ReplayScrubber } from "./trading/ReplayScrubber.tsx";
import { WatchlistPanel } from "./trading/WatchlistPanel.tsx";

/**
 * The default terminal layout.
 *
 * All shared state comes from `<TerminalProvider>` (see src/terminal/context)
 * — this component only arranges the panels and owns the layout: panel sizes,
 * which tab is open, what is visible. Applications that want a different
 * arrangement compose the panels from `src/terminal/panels.tsx` instead of
 * modifying this file.
 */

export function TradingPage() {
  // Shared terminal state lives in <TerminalProvider>; this component is the
  // default layout on top of it. Panel sizes, tab selection and visibility are
  // layout concerns, so they stay here.
  const {
    selectedSymbol,
    setSelectedSymbol,
    symbols,
    symbolInfo,
    pipDigits,
    isDark,
    timeframe,
    setTimeframe: handleTimeframeChange,
    candles,
    replayCandles,
    replayTradeEvents,
    isReplaying,
    chartPrefs,
    activeIndicators,
    toggleIndicator,
    clearIndicators: handleClearIndicators,
    activePlugins,
    togglePlugin: handleTogglePlugin,
    setPlugins: handleSetPlugins,
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
    quickOrder: handleQuickOrder,
    modifyPositionLevels: handleChartModifyPosition,
    editPosition: setModifyingPosition,
    editOrder: setModifyingOrder,
    journalEntries,
    journalLoading,
    createJournal,
    updateJournal,
    deleteJournal,
  } = useTerminal();

  // ── Layout state ──
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [bottomTab, setBottomTab] = useState<
    "positions" | "orders" | "history" | "journal" | "calendar" | "news"
  >("positions");
  const [rightPanel, setRightPanel] = useState<
    "order" | "dom" | "watchlist" | "news" | "tv-analysis"
  >("order");
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  // ── Vertical resize: chart vs bottom panel ──
  const [bottomPanelHeight, setBottomPanelHeight] = useState(() => {
    const saved = safeStorage.getItem("bottomPanelHeight");
    return saved ? parseInt(saved, 10) : 220;
  });
  const resizingRef = useRef(false);
  const resizeStartY = useRef(0);
  const resizeStartH = useRef(0);
  // rAF-batched (audit #44): each mousemove used to synchronously re-render
  // the whole page and trigger a chart applyOptions; now at most one render
  // per frame while dragging.
  const resizeRafRef = useRef<number | null>(null);
  const resizePendingY = useRef<number | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const clientY = "touches" in e ? e.touches[0]!.clientY : e.clientY;
      resizeStartY.current = clientY;
      resizeStartH.current = bottomPanelHeight;

      const applyResize = () => {
        resizeRafRef.current = null;
        const y = resizePendingY.current;
        if (y == null || !resizingRef.current) return;
        const delta = resizeStartY.current - y;
        setBottomPanelHeight(Math.max(100, Math.min(600, resizeStartH.current + delta)));
      };
      const onMove = (ev: MouseEvent | TouchEvent) => {
        if (!resizingRef.current) return;
        resizePendingY.current =
          "touches" in ev ? ev.touches[0]!.clientY : (ev as MouseEvent).clientY;
        if (resizeRafRef.current !== null) return;
        resizeRafRef.current = requestAnimationFrame(applyResize);
      };
      const onUp = () => {
        resizingRef.current = false;
        if (resizeRafRef.current !== null) {
          cancelAnimationFrame(resizeRafRef.current);
          resizeRafRef.current = null;
        }
        setBottomPanelHeight((h) => {
          safeStorage.setItem("bottomPanelHeight", String(h));
          return h;
        });
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    },
    [bottomPanelHeight],
  );

  // Loading a chart template swaps the whole indicator list; the toolbar's
  // own menu toggles one at a time.
  const setIndicators = useCallback(
    (next: IndicatorType[]) => {
      for (const type of next) if (!activeIndicators.includes(type)) toggleIndicator(type);
      for (const type of activeIndicators) if (!next.includes(type)) toggleIndicator(type);
    },
    [activeIndicators, toggleIndicator],
  );

  return (

    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Mobile Account Bar (small screens only) ────── */}
      <div className="md:hidden">
        <MobileAccountBar
          balance={account?.balance ?? 0}
          equity={account?.equity ?? account?.balance ?? 0}
          margin={account?.margin ?? 0}
          pnl={positionPnl}
        />
      </div>

      {/* ── Top Toolbar ──────────────────────────────────── */}
      <div className="relative shrink-0">
        <ChartToolbar
          selectedSymbol={selectedSymbol}
          symbols={symbols}
          onSymbolChange={setSelectedSymbol}
          timeframe={timeframe}
          onTimeframeChange={handleTimeframeChange}
          activeIndicators={activeIndicators}
          onToggleIndicator={toggleIndicator}
          showIndicatorMenu={showIndicatorMenu}
          onToggleIndicatorMenu={() => setShowIndicatorMenu((v) => !v)}
          drawingTool={drawingTool}
          onDrawingTool={setDrawingTool}
          drawings={drawings}
          onClearDrawings={clearDrawings}
          rightPanel={rightPanel}
          onRightPanel={setRightPanel}
          showRightPanel={showRightPanel}
          onToggleRightPanel={() => setShowRightPanel((v) => !v)}
          symbolInfo={symbolInfo}
          isReplaying={isReplaying}
          replayAccountId={activeAccountId}
          activePlugins={activePlugins}
          onTogglePlugin={handleTogglePlugin}
          onSetIndicators={setIndicators}
          onSetPlugins={handleSetPlugins}
          magnetMode={chartPrefs.magnetMode}
          onCycleMagnet={cycleMagnetMode}
          stayInDrawingMode={chartPrefs.stayInDrawingMode}
          onToggleStayInDrawingMode={() =>
            updateChartPreferences({ stayInDrawingMode: !chartPrefs.stayInDrawingMode })
          }
        />
        {/* Live-feed status: dot + label at the toolbar's right edge. */}
        <div className="absolute right-2 top-1.5 z-20 flex items-center rounded bg-card/90 px-1.5 py-0.5 border border-border/60 pointer-events-none">
          <ConnectionIndicator />
        </div>
      </div>

      <MarketClosedBanner symbolInfo={symbolInfo} />

      {/* ── Main Layout ──────────────────────────────────── */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Chart + Bottom Panel */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Chart Area */}
          <div className="flex-1 min-h-[200px] relative">
            <ChartPanel
              candles={replayCandles ?? candles ?? []}
              selectedSymbol={selectedSymbol}
              timeframe={timeframe}
              isDark={isDark}
              activeIndicators={activeIndicators}
              drawingTool={drawingTool}
              drawings={drawings}
              onAddDrawing={addDrawing}
              onUpdateDrawing={updateDrawing}
              onRemoveDrawing={removeDrawing}
              onDrawingComplete={() => setDrawingTool("none")}
              onDrawingToolSelect={setDrawingTool}
              onUndoDrawing={undoDrawing}
              onRedoDrawing={redoDrawing}
              magnetMode={chartPrefs.magnetMode}
              stayInDrawingMode={chartPrefs.stayInDrawingMode}
              positions={chartPositions}
              orders={chartOrders}
              pipDigits={pipDigits}
              symbolInfo={symbolInfo}
              onModifyPosition={handleChartModifyPosition}
              replayTradeEvents={replayTradeEvents}
              isReplaying={isReplaying}
              activePlugins={activePlugins}
              onTogglePlugin={handleTogglePlugin}
              accountEquity={account?.equity ?? account?.balance ?? 0}
              accountId={activeAccountId}
              onQuickOrder={handleQuickOrder}
              onClearDrawings={clearDrawings}
              onClearIndicators={handleClearIndicators}
            />
          </div>

          {/* Replay timeline scrubber — disabled until the feature is QA'd */}
          {REPLAY_ENABLED && isReplaying && activeAccountId != null && (
            <ReplayScrubber accountId={activeAccountId} />
          )}

          {/* ── Resize Handle ── */}
          <div
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
            className="hidden md:flex h-1.5 cursor-row-resize items-center justify-center hover:bg-primary/20 active:bg-primary/30 transition-colors group border-t border-border bg-secondary/40 touch-none"
          >
            <div className="w-8 h-0.5 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>

          {/* Bottom Panel (Positions / Orders / Journal / Calendar / News) */}
          <BottomPanel
            tab={bottomTab}
            onTabChange={setBottomTab}
            positions={positions}
            orders={orders}
            accountId={activeAccountId}
            onModifyPosition={setModifyingPosition}
            onModifyOrder={setModifyingOrder}
            onSelectPositionSymbol={setSelectedSymbol}
            onSelectOrderSymbol={setSelectedSymbol}
            height={bottomPanelHeight}
            isFeedConnected={isFeedConnected}
            journalEntries={journalEntries}
            journalLoading={journalLoading}
            onCreateJournal={createJournal}
            onUpdateJournal={updateJournal}
            onDeleteJournal={deleteJournal}
          />
        </div>

        {/* Right Panel */}
        {showRightPanel && (
          <div className="hidden md:flex w-full md:w-[280px] xl:w-[320px] border-t md:border-t-0 md:border-l border-border flex-col bg-card overflow-hidden shrink-0 md:max-h-none">
            {rightPanel === "order" && (
              <OrderPanel
                symbol={selectedSymbol}
                symbolInfo={symbolInfo}
                accountId={activeAccountId}
                oneClick={oneClick}
                onToggleOneClick={toggleOneClick}
                onConfirmOrder={setConfirmOrder}
                accountBalance={account?.balance}
                isFeedConnected={isFeedConnected}
                soundMuted={soundMuted}
                onToggleMute={toggleSoundMute}
                onOrderSuccess={onOrderSuccess}
              />
            )}
            {rightPanel === "dom" && <DOMPanel symbol={selectedSymbol} />}
            {rightPanel === "watchlist" && (
              <WatchlistPanel
                symbols={symbols}
                selectedSymbol={selectedSymbol}
                onSelect={setSelectedSymbol}
                oneClick={oneClick}
                accountId={activeAccountId}
                isFeedConnected={isFeedConnected}
              />
            )}
            {rightPanel === "news" && (
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                <MarketNewsFeed symbol={selectedSymbol} />
              </div>
            )}
            {rightPanel === "tv-analysis" && (
              <div className="flex-1 overflow-hidden">
                <TradingViewTechnicalAnalysis
                  symbol={selectedSymbol}
                  theme={isDark ? "dark" : "light"}
                  interval={timeframe}
                  width="100%"
                  height="100%"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Mobile Trading Panel (small screens only) ──── */}
      <div className="md:hidden">
        {!mobilePanelOpen && (
          <button
            onClick={() => setMobilePanelOpen(true)}
            className="fixed bottom-20 right-4 z-40 bg-primary text-primary-foreground rounded-full w-14 h-14 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
          >
            <span className="text-2xl font-bold">$</span>
          </button>
        )}
        {mobilePanelOpen && (
          <>
            {/* Scrim (#25): the chart used to stay tappable behind the sheet. */}
            <div
              className="fixed inset-0 z-40 bg-black/50 md:hidden"
              onClick={() => setMobilePanelOpen(false)}
            />
            <div className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto bg-card border-t border-border rounded-t-2xl shadow-2xl safe-area-bottom animate-slide-up md:hidden">
              <div className="flex justify-center py-1">
                <button
                  onClick={() => setMobilePanelOpen(false)}
                  className="w-10 h-1.5 rounded-full bg-muted-foreground/30"
                />
              </div>
            <MobileTradingPanel
              symbol={selectedSymbol}
              positions={positions || []}
              onPlaceOrder={(order) => {
                if (oneClick) {
                  void submitOrderDirect({
                    ...order,
                    accountId: activeAccountId!,
                  } as PlaceOrderInput)
                    .then(onOrderSuccess)
                    .catch(() => {
                      // Already reported by submitOrderDirect.
                    });
                  setMobilePanelOpen(false);
                  return;
                }
                setConfirmOrder({
                  ...(order as PlaceOrderInput),
                  accountId: activeAccountId!,
                  _submit: () =>
                    submitOrderDirect({
                      ...order,
                      accountId: activeAccountId!,
                    } as PlaceOrderInput),
                });
                setMobilePanelOpen(false);
              }}
            />
            </div>
          </>
        )}
      </div>

    </div>
  );
}


import { useEffect, useRef } from "react";
import type {
  CandlestickData,
  HistogramData,
  HistogramSeriesPartialOptions,
  IChartApi,
  ISeriesApi,
  LineData,
  LineSeriesPartialOptions,
  Time,
} from "lightweight-charts";
import { LineStyle } from "lightweight-charts";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  stochastic,
  vwap,
  INDICATOR_REGISTRY,
  type IndicatorType,
} from "../../lib/indicators.ts";
import { toIndicatorCandles } from "./utils.ts";
import { CHART_COLORS } from "./constants.ts";

/**
 * Paints the active indicators onto the chart.
 *
 * Series are REUSED, not recreated (audit #8/#34): the previous version tore
 * every indicator series down and re-added it whenever the chart data
 * identity changed — i.e. on every periodic refetch (each candle close) and
 * every replay cursor tick — which flickered and forced a full repaint.
 * Here the series maps persist and only `setData` is re-run; series are
 * removed only when their indicator is switched off, and recreated only when
 * the chart instance itself is (chartEpoch bump).
 */
export function useIndicators(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  chartData: CandlestickData<Time>[],
  activeIndicators: IndicatorType[],
  isDark: boolean,
  chartEpoch = 0,
): void {
  const lineSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const histSeriesRef = useRef<Map<string, ISeriesApi<"Histogram">>>(new Map());
  const epochRef = useRef(chartEpoch);
  const colors = isDark ? CHART_COLORS.dark : CHART_COLORS.light;

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || chartData.length === 0) return;
    const chart = chartRef.current;

    // The chart instance was (re)created: series attached to the dead chart
    // are gone — drop the stale handles without removeSeries (their chart no
    // longer exists; calling removeSeries on it would throw).
    if (epochRef.current !== chartEpoch) {
      lineSeriesRef.current.clear();
      histSeriesRef.current.clear();
      epochRef.current = chartEpoch;
    }

    const indCandles = toIndicatorCandles(chartData);
    const desiredLines = new Set<string>();
    const desiredHists = new Set<string>();

    const line = (key: string, opts: LineSeriesPartialOptions): ISeriesApi<"Line"> => {
      desiredLines.add(key);
      let s = lineSeriesRef.current.get(key);
      if (!s) {
        s = chart.addLineSeries(opts);
        lineSeriesRef.current.set(key, s);
      }
      return s;
    };
    const histogram = (
      key: string,
      opts: HistogramSeriesPartialOptions = {},
    ): ISeriesApi<"Histogram"> => {
      desiredHists.add(key);
      let s = histSeriesRef.current.get(key);
      if (!s) {
        s = chart.addHistogramSeries(opts);
        histSeriesRef.current.set(key, s);
      }
      return s;
    };
    const setLine = (key: string, opts: LineSeriesPartialOptions, data: LineData<Time>[]) => {
      line(key, opts).setData(data);
    };
    const setHist = (
      key: string,
      opts: HistogramSeriesPartialOptions,
      data: HistogramData<Time>[],
    ) => {
      histogram(key, opts).setData(data);
    };

    for (const type of activeIndicators) {
      const config = INDICATOR_REGISTRY.find((r) => r.type === type);
      if (!config) continue;

      switch (type) {
        case "SMA": {
          const data = sma(indCandles, config.defaultParams.period!);
          setLine(
            "SMA",
            { color: config.color, lineWidth: 1, priceScaleId: "right" },
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "EMA": {
          const data = ema(indCandles, config.defaultParams.period!);
          setLine(
            "EMA",
            { color: config.color, lineWidth: 1, priceScaleId: "right" },
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "RSI": {
          const data = rsi(indCandles, config.defaultParams.period);
          setLine(
            "RSI",
            { color: config.color, lineWidth: 1, priceScaleId: "rsi" },
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          setLine(
            "RSI-70",
            { color: "#555", lineWidth: 1, lineStyle: LineStyle.Dashed, priceScaleId: "rsi" },
            data.map((p) => ({ time: p.time as Time, value: 70 })),
          );
          setLine(
            "RSI-30",
            { color: "#555", lineWidth: 1, lineStyle: LineStyle.Dashed, priceScaleId: "rsi" },
            data.map((p) => ({ time: p.time as Time, value: 30 })),
          );
          break;
        }
        case "MACD": {
          const data = macd(
            indCandles,
            config.defaultParams.fast,
            config.defaultParams.slow,
            config.defaultParams.signal,
          );
          setLine(
            "MACD-line",
            { color: "#2196f3", lineWidth: 1, priceScaleId: "macd" },
            data.macd.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          setLine(
            "MACD-signal",
            { color: "#ff9800", lineWidth: 1, priceScaleId: "macd" },
            data.signal.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          // Histogram colours are baked into the data; re-setData picks up the
          // current palette when the theme flips.
          setHist(
            "MACD-hist",
            { priceScaleId: "macd" },
            data.histogram.map((p) => ({
              time: p.time as Time,
              value: p.value,
              color: p.value >= 0 ? colors.up + "99" : colors.down + "99",
            })),
          );
          break;
        }
        case "BOLL": {
          const data = bollingerBands(
            indCandles,
            config.defaultParams.period,
            config.defaultParams.stdDev,
          );
          setLine(
            "BOLL-upper",
            { color: config.color + "80", lineWidth: 1, priceScaleId: "right" },
            data.upper.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          setLine(
            "BOLL-mid",
            { color: config.color, lineWidth: 1, priceScaleId: "right" },
            data.middle.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          setLine(
            "BOLL-lower",
            { color: config.color + "80", lineWidth: 1, priceScaleId: "right" },
            data.lower.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "ATR": {
          const data = atr(indCandles, config.defaultParams.period);
          setLine(
            "ATR",
            { color: config.color, lineWidth: 1, priceScaleId: "atr" },
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "STOCH": {
          const data = stochastic(
            indCandles,
            config.defaultParams.kPeriod,
            config.defaultParams.dPeriod,
          );
          setLine(
            "STOCH-K",
            { color: "#ab47bc", lineWidth: 1, priceScaleId: "stoch" },
            data.k.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          setLine(
            "STOCH-D",
            { color: "#ff7043", lineWidth: 1, priceScaleId: "stoch" },
            data.d.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "VWAP": {
          const data = vwap(indCandles);
          setLine(
            "VWAP",
            { color: config.color, lineWidth: 2, lineStyle: LineStyle.Dashed, priceScaleId: "right" },
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
      }
    }

    // Remove series whose indicator was switched off.
    for (const [key, series] of lineSeriesRef.current) {
      if (desiredLines.has(key)) continue;
      try {
        chart.removeSeries(series);
      } catch {
        /* already gone */
      }
      lineSeriesRef.current.delete(key);
    }
    for (const [key, series] of histSeriesRef.current) {
      if (desiredHists.has(key)) continue;
      try {
        chart.removeSeries(series);
      } catch {
        /* already gone */
      }
      histSeriesRef.current.delete(key);
    }
    // chartRef/candleSeriesRef are stable refs; colors derived from isDark dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndicators, chartData, isDark, chartEpoch]);
}

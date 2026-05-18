import { useEffect, useRef } from 'react';
import {
  createChart, ColorType,
  type IChartApi, type ISeriesApi,
  type CandlestickData, type LineData, type Time,
} from 'lightweight-charts';
import { baseUnitsToPrice } from '../api';
import type { AppState } from '../store';

type View = '1m' | '5m' | 'live';

interface Props {
  state: AppState;
  onIntervalChange: (i: View) => void;
}

function toCandleBars(candles: AppState['candles1m']): CandlestickData[] {
  return candles.map((c) => ({
    time: Math.floor(c.bucketStart / 1000) as Time,
    open: baseUnitsToPrice(c.open),
    high: baseUnitsToPrice(c.high),
    low: baseUnitsToPrice(c.low),
    close: baseUnitsToPrice(c.close),
  }));
}

// Live view: each trade becomes a (time, price) point. lightweight-charts
// requires strictly increasing unique times, so if multiple trades land
// inside the same second we keep the LAST price for that second.
function toLineBars(trades: AppState['trades']): LineData[] {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const byTime = new Map<number, number>();
  for (const t of sorted) {
    byTime.set(Math.floor(t.ts / 1000), baseUnitsToPrice(t.price));
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, price]) => ({ time: sec as Time, value: price }));
}

export function CandlestickChart({ state, onIntervalChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Stored as ISeriesApi<'Candlestick' | 'Area'>; refer to it generically below.
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);
  const seriesTypeRef = useRef<'candle' | 'live' | null>(null);

  // Init chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#151a25' },
        textColor: '#7a8198',
      },
      grid: {
        vertLines: { color: '#1c2230' },
        horzLines: { color: '#1c2230' },
      },
      rightPriceScale: { borderColor: '#232a3a' },
      timeScale: { borderColor: '#232a3a', timeVisible: true, secondsVisible: true },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    chartRef.current = chart;

    const resize = (): void => {
      if (!containerRef.current || !chart) return;
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      seriesTypeRef.current = null;
    };
  }, []);

  // (Re)create the series when the view type changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const wantType: 'candle' | 'live' = state.candleInterval === 'live' ? 'live' : 'candle';
    if (seriesTypeRef.current !== wantType) {
      if (seriesRef.current) chart.removeSeries(seriesRef.current);
      if (wantType === 'candle') {
        seriesRef.current = chart.addCandlestickSeries({
          upColor: '#16c784', downColor: '#ea3943',
          borderUpColor: '#16c784', borderDownColor: '#ea3943',
          wickUpColor: '#16c784', wickDownColor: '#ea3943',
        });
      } else {
        seriesRef.current = chart.addAreaSeries({
          lineColor: '#ffcb52',
          topColor: 'rgba(255,203,82,0.35)',
          bottomColor: 'rgba(255,203,82,0.02)',
          lineWidth: 2,
        });
      }
      seriesTypeRef.current = wantType;
    }
  }, [state.candleInterval]);

  // Push data on every relevant state change.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (state.candleInterval === 'live') {
      (series as ISeriesApi<'Area'>).setData(toLineBars(state.trades));
    } else {
      const data = state.candleInterval === '1m' ? state.candles1m : state.candles5m;
      (series as ISeriesApi<'Candlestick'>).setData(toCandleBars(data));
    }
  }, [state.candleInterval, state.candles1m, state.candles5m, state.trades]);

  return (
    <div className="panel chart">
      <h3>
        Price chart
        <div className="toolbar">
          {(['live', '1m', '5m'] as const).map((i) => (
            <button
              key={i}
              className={state.candleInterval === i ? 'active' : ''}
              onClick={() => onIntervalChange(i)}
            >
              {i === 'live' ? 'Live' : i}
            </button>
          ))}
        </div>
      </h3>
      <div className="body" style={{ padding: 0 }}>
        <div ref={containerRef} className="chart-canvas" />
      </div>
    </div>
  );
}

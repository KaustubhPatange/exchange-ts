import { useEffect, useRef } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi, type CandlestickData, type Time } from 'lightweight-charts';
import { baseUnitsToPrice } from '../api';
import type { AppState } from '../store';

interface Props {
  state: AppState;
  onIntervalChange: (i: '1m' | '5m') => void;
}

function toBars(candles: AppState['candles1m']): CandlestickData[] {
  // bucketStart is ms epoch; lightweight-charts wants seconds for time-based.
  // We use UTCTimestamp (number-of-seconds).
  return candles.map((c) => ({
    time: Math.floor(c.bucketStart / 1000) as Time,
    open: baseUnitsToPrice(c.open),
    high: baseUnitsToPrice(c.high),
    low: baseUnitsToPrice(c.low),
    close: baseUnitsToPrice(c.close),
  }));
}

export function CandlestickChart({ state, onIntervalChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // Init chart
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
      timeScale: { borderColor: '#232a3a', timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#16c784', downColor: '#ea3943',
      borderUpColor: '#16c784', borderDownColor: '#ea3943',
      wickUpColor: '#16c784', wickDownColor: '#ea3943',
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const resize = () => {
      if (!containerRef.current || !chart) return;
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // Update series whenever candles or interval change.
  useEffect(() => {
    if (!seriesRef.current) return;
    const data = state.candleInterval === '1m' ? state.candles1m : state.candles5m;
    seriesRef.current.setData(toBars(data));
  }, [state.candles1m, state.candles5m, state.candleInterval]);

  return (
    <div className="panel chart">
      <h3>
        Candles
        <div className="toolbar">
          {(['1m', '5m'] as const).map((i) => (
            <button key={i} className={state.candleInterval === i ? 'active' : ''} onClick={() => onIntervalChange(i)}>
              {i}
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

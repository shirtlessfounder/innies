'use client';

import { useEffect, useRef } from 'react';
import {
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts';
import type { AnalyticsMetric, AnalyticsSeries } from '../../lib/analytics/types';
import styles from './AnalyticsChart.module.css';

type AnalyticsChartProps = {
  metric: AnalyticsMetric;
  series: AnalyticsSeries[];
  loading?: boolean;
};

const CHART_COLORS = ['#0a6b7b', '#26667c', '#3b725a', '#8b5c0a', '#8b3a4f', '#5d4ba6'];

function seriesColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? '#0a6b7b';
}

function toChartTime(timestamp: string): Time {
  const parsed = Date.parse(timestamp);
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed / 1000) as Time;
  }

  return timestamp as Time;
}

function toLineData(series: AnalyticsSeries): LineData<Time>[] {
  return series.points.map((point) => ({
    time: toChartTime(point.timestamp),
    value: point.value,
  }));
}

function metricTitle(metric: AnalyticsMetric): string {
  switch (metric) {
    case 'usageUnits':
      return 'Usage Units';
    case 'requests':
      return 'Requests';
    case 'latencyP50Ms':
      return 'Latency P50';
    case 'errorRate':
      return 'Error Rate';
    default:
      return metric;
  }
}

export function AnalyticsChart({ metric, series, loading = false }: AnalyticsChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<ISeriesApi<'Line'>[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#37525c',
        attributionLogo: false,
        fontFamily: "'SFMono-Regular', 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(50, 86, 96, 0.09)' },
        horzLines: { color: 'rgba(50, 86, 96, 0.09)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(50, 86, 96, 0.12)',
        scaleMargins: {
          top: 0.12,
          bottom: 0.18,
        },
      },
      timeScale: {
        borderColor: 'rgba(50, 86, 96, 0.12)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: {
          color: 'rgba(10, 107, 123, 0.36)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0a6b7b',
        },
        horzLine: {
          color: 'rgba(10, 107, 123, 0.22)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0a6b7b',
        },
      },
      handleScroll: {
        vertTouchDrag: false,
      },
    });

    chartRef.current = chart;

    return () => {
      seriesRefs.current.forEach((entry) => chart.removeSeries(entry));
      seriesRefs.current = [];
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    seriesRefs.current.forEach((entry) => chart.removeSeries(entry));
    seriesRefs.current = [];

    if (series.length === 0) return;

    series.forEach((entry, index) => {
      const color = seriesColor(index);
      const chartSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: entry.partial ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderWidth: 2,
        crosshairMarkerBackgroundColor: color,
        crosshairMarkerBorderColor: '#f8fbfc',
      });

      chartSeries.setData(toLineData(entry));
      seriesRefs.current.push(chartSeries);
    });

    chart.timeScale().fitContent();
  }, [series]);

  return (
    <div className={styles.chartShell}>
      <div className={styles.chartWrap}>
        <div ref={containerRef} className={styles.chartSurface} />

        {(loading || series.length > 0) ? (
          <div className={styles.chartOverlay}>
            <div className={styles.chartStatus}>
              <span>{metricTitle(metric)}</span>
              {loading ? <span>Updating</span> : null}
            </div>
          </div>
        ) : null}

        {series.length === 0 ? (
          <div className={styles.emptyState}>
            Select rows to render a historical chart.
          </div>
        ) : null}
      </div>

      {series.length > 0 ? (
        <div className={styles.legend}>
          {series.map((entry, index) => (
            <div key={`${entry.entityType}-${entry.entityId}`} className={styles.legendItem}>
              <span className={styles.legendSwatch} style={{ background: seriesColor(index) }} />
              <span className={styles.legendLabel}>{entry.label}</span>
              {entry.partial ? <span className={styles.legendPartial}>Partial</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

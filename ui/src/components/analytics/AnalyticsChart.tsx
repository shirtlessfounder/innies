'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
   type LineData,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { formatChartAxisValue, formatTimestamp, seriesValueLabel } from '../../lib/analytics/present';
import type { AnalyticsAggregateSeries, AnalyticsMetric, AnalyticsSeries } from '../../lib/analytics/types';
import styles from './AnalyticsChart.module.css';

type AnalyticsChartProps = {
  metric: AnalyticsMetric;
  series: AnalyticsSeries[];
  aggregates?: AnalyticsAggregateSeries[];
  loading?: boolean;
};

const CHART_COLORS = ['#0b7285', '#2f6f62', '#8b5e16', '#8f3d4f', '#4d648d', '#576b2c'];

type TooltipRow = {
  label: string;
  value: string;
  color: string;
  partial: boolean;
  aggregateKind: AnalyticsAggregateSeries['kind'] | null;
};

type TooltipState = {
  left: number;
  top: number;
  timestamp: string;
  rows: TooltipRow[];
};

type SeriesMeta = {
  label: string;
  color: string;
  partial: boolean;
  aggregateKind: AnalyticsAggregateSeries['kind'] | null;
};

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

function readHoveredValue(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  if ('value' in data && typeof (data as { value?: unknown }).value === 'number') {
    return (data as { value: number }).value;
  }
  if ('close' in data && typeof (data as { close?: unknown }).close === 'number') {
    return (data as { close: number }).close;
  }
  return null;
}

function formatTooltipTimestamp(time: Time | undefined): string {
  if (time === undefined) return '--';

  if (typeof time === 'number') {
    return formatTimestamp(new Date(time * 1000).toISOString());
  }

  if (typeof time === 'string') {
    return formatTimestamp(time);
  }

  if (time && typeof time === 'object' && 'year' in time && 'month' in time && 'day' in time) {
    const iso = `${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}T00:00:00.000Z`;
    return formatTimestamp(iso);
  }

  return '--';
}

export function AnalyticsChart({ metric, series, aggregates = [], loading = false }: AnalyticsChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const seriesMetaRef = useRef<Map<ISeriesApi<'Line'>, SeriesMeta>>(new Map());
  const metricRef = useRef(metric);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  metricRef.current = metric;

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#294650',
        attributionLogo: false,
        fontFamily: "'SFMono-Regular', 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 10,
      },
      localization: {
        priceFormatter: (value: number) => formatChartAxisValue(metric, value),
      },
      grid: {
        vertLines: { color: 'rgba(28, 62, 74, 0.08)' },
        horzLines: { color: 'rgba(28, 62, 74, 0.08)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(28, 62, 74, 0.14)',
        scaleMargins: {
          top: 0.08,
          bottom: 0.12,
        },
      },
      timeScale: {
        borderColor: 'rgba(28, 62, 74, 0.14)',
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
          labelVisible: false,
          labelBackgroundColor: '#0a6b7b',
        },
      },
      handleScroll: {
        vertTouchDrag: false,
      },
    });

    chartRef.current = chart;

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const container = containerRef.current;
      if (!container || !param.point || param.time === undefined || param.seriesData.size === 0) {
        setTooltip(null);
        return;
      }

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (param.point.x < 0 || param.point.x > width || param.point.y < 0 || param.point.y > height) {
        setTooltip(null);
        return;
      }

      const rows: TooltipRow[] = [];
      for (const [seriesApi, meta] of seriesMetaRef.current.entries()) {
        const value = readHoveredValue(param.seriesData.get(seriesApi));
        if (value === null) continue;
        rows.push({
          label: meta.label,
          value: seriesValueLabel(metricRef.current, value),
          color: meta.color,
          partial: meta.partial,
          aggregateKind: meta.aggregateKind,
        });
      }

      if (rows.length === 0) {
        setTooltip(null);
        return;
      }

      const tooltipWidth = 220;
      const tooltipHeight = 44 + rows.length * 24;
      const left = Math.max(12, Math.min(param.point.x + 16, width - tooltipWidth - 12));
      const top = Math.max(12, Math.min(param.point.y + 16, height - tooltipHeight - 12));

      setTooltip({
        left,
        top,
        timestamp: formatTooltipTimestamp(param.time),
        rows,
      });
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      seriesRefs.current.forEach((entry) => chart.removeSeries(entry));
      seriesRefs.current = [];
      seriesMetaRef.current.clear();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    chart.applyOptions({
      localization: {
        priceFormatter: (value: number) => formatChartAxisValue(metric, value),
      },
    });

    seriesRefs.current.forEach((entry) => chart.removeSeries(entry));
    seriesRefs.current = [];
    seriesMetaRef.current.clear();
    setTooltip(null);

    if (series.length === 0 && aggregates.length === 0) return;

    aggregates.forEach((entry) => {
      if (entry.points.length === 0) return;

      const aggregateSeries = chart.addSeries(LineSeries, {
        color: entry.color,
        lineWidth: entry.kind === 'total' ? 3 : 2,
        lineStyle: entry.partial ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerRadius: 0,
      });

      aggregateSeries.setData(toLineData({
        entityId: `aggregate-${entry.id}`,
        entityType: 'token',
        label: entry.label,
        metric,
        partial: entry.partial,
        points: entry.points,
      }));
      seriesRefs.current.push(aggregateSeries);
      seriesMetaRef.current.set(aggregateSeries, {
        label: entry.label,
        color: entry.color,
        partial: entry.partial,
        aggregateKind: entry.kind,
      });
    });

    series.forEach((entry, index) => {
      const color = seriesColor(index);
      const chartSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: entry.partial ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerRadius: 3,
        crosshairMarkerBorderWidth: 1,
        crosshairMarkerBackgroundColor: color,
        crosshairMarkerBorderColor: '#f8fbfc',
      });

      chartSeries.setData(toLineData(entry));
      seriesRefs.current.push(chartSeries);
      seriesMetaRef.current.set(chartSeries, {
        label: entry.label,
        color,
        partial: entry.partial,
        aggregateKind: null,
      });
    });

    chart.timeScale().fitContent();
  }, [aggregates, metric, series]);

  const lastAggregateRowIndex = tooltip
    ? tooltip.rows.reduce((lastIndex, row, index) => (row.aggregateKind ? index : lastIndex), -1)
    : -1;

  return (
    <div className={styles.chartShell}>
      <div className={styles.chartWrap}>
        <div ref={containerRef} className={styles.chartSurface} />

        {(loading || series.length > 0 || aggregates.length > 0) ? (
          <div className={styles.chartOverlay}>
            <div className={styles.chartStatus}>
              <span>{metricTitle(metric)}</span>
              {loading ? <span>Updating</span> : null}
            </div>
          </div>
        ) : null}

        {tooltip ? (
          <div
            className={styles.chartTooltip}
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            <div className={styles.chartTooltipTime}>{tooltip.timestamp}</div>
            <div className={styles.chartTooltipRows}>
              {tooltip.rows.map((row, index) => (
                <div
                  key={`${row.label}-${row.value}`}
                  className={`${styles.chartTooltipRow} ${
                    index === lastAggregateRowIndex && index < tooltip.rows.length - 1
                      ? styles.chartTooltipRowDivider
                      : ''
                  }`}
                >
                  <span className={styles.chartTooltipLabelWrap}>
                    <span className={styles.chartTooltipSwatch} style={{ background: row.color }} />
                    <span className={styles.chartTooltipLabel}>{row.label}</span>
                    {row.partial ? <span className={styles.chartTooltipPartial}>Partial</span> : null}
                  </span>
                  <span className={styles.chartTooltipValue}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {series.length === 0 && aggregates.length === 0 ? (
          <div className={styles.emptyState}>
            No visible traces.
          </div>
        ) : null}
      </div>

      {series.length > 0 || aggregates.length > 0 ? (
        <div className={styles.legend}>
          {aggregates.map((entry) => (
            <div
              key={entry.id}
              className={`${styles.legendItem} ${entry.kind === 'total' ? styles.legendItemTotal : ''}`}
            >
              <span
                className={`${styles.legendSwatch} ${styles.legendSwatchAggregate} ${entry.kind === 'total' ? styles.legendSwatchTotal : ''}`}
                style={{ background: entry.color }}
              />
              <span className={styles.legendLabel}>{entry.label}</span>
              {entry.partial ? <span className={styles.legendPartial}>Partial</span> : null}
            </div>
          ))}
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

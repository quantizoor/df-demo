"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency, formatDelta } from "../lib/client/format";
import type { PerformancePoint } from "../lib/client/types";

const tooltipStyle = {
  background: "#111821",
  border: "1px solid #2b3948",
  borderRadius: 10,
  boxShadow: "0 18px 45px rgba(0,0,0,.35)",
  color: "#eaf0f5",
};

function promotionShape(props: { cx?: number; cy?: number; payload?: PerformancePoint }) {
  if (!props.payload?.promoted || props.cx == null || props.cy == null) {
    return <g />;
  }
  return (
    <g>
      <circle cx={props.cx} cy={props.cy} r={8} fill="#0d2e29" stroke="#37d4a5" strokeWidth={2} />
      <circle cx={props.cx} cy={props.cy} r={3} fill="#37d4a5" />
    </g>
  );
}

export function ImprovementChart({ points }: { points: PerformancePoint[] }) {
  const data = points.flatMap((point, index) => {
    const item = {
      ...point,
      index: point.experimentNumber ?? index + 1,
      deltaPoints:
        point.meanRewardDelta == null ? null : Number((point.meanRewardDelta * 100).toFixed(2)),
    };
    const previous = points[index - 1];
    if (
      previous?.panelDigest != null &&
      point.panelDigest != null &&
      previous.panelDigest !== point.panelDigest
    ) {
      return [
        {
          experimentId: `panel-break-${point.experimentId}`,
          index: item.index - 0.5,
          deltaPoints: null,
          panelDigest: null,
          promoted: false,
        },
        item,
      ];
    }
    return [item];
  });
  const panelChanges = points.flatMap((point, index) =>
    index > 0 &&
    point.panelDigest != null &&
    points[index - 1]?.panelDigest != null &&
    point.panelDigest !== points[index - 1]?.panelDigest
      ? [{ ...point, index: point.experimentNumber ?? index + 1 }]
      : [],
  );
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={330}>
        <ComposedChart data={data} margin={{ top: 16, right: 18, left: -12, bottom: 4 }}>
          <CartesianGrid stroke="#23303d" strokeDasharray="3 5" vertical={false} />
          <XAxis dataKey="index" stroke="#778797" tickLine={false} axisLine={false} />
          <YAxis
            stroke="#778797"
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => `${value > 0 ? "+" : ""}${value} pp`}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value) => [`${Number(value) >= 0 ? "+" : ""}${value} pp`, "Matched delta"]}
            labelFormatter={(label) => `Experiment ${label}`}
          />
          <ReferenceLine y={0} stroke="#58697a" />
          {panelChanges.map((point) => (
            <ReferenceLine
              key={`panel-${point.experimentId}`}
              x={point.index}
              stroke="#ad85ff"
              strokeDasharray="2 5"
              label={{ value: "new panel", fill: "#9981c9", fontSize: 9, position: "insideTop" }}
            />
          ))}
          <Line
            type="monotone"
            dataKey="deltaPoints"
            stroke="#45b9dc"
            strokeWidth={2.5}
            dot={{ r: 3.5, fill: "#0e141b", stroke: "#45b9dc", strokeWidth: 2 }}
            connectNulls={false}
          />
          <Scatter dataKey="deltaPoints" shape={promotionShape} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PairedRewardsChart({ points }: { points: PerformancePoint[] }) {
  const data = points.flatMap((point, index) => {
    const item = {
      ...point,
      index: point.experimentNumber ?? index + 1,
    };
    const previous = points[index - 1];
    if (
      previous?.panelDigest != null &&
      point.panelDigest != null &&
      previous.panelDigest !== point.panelDigest
    ) {
      return [
        {
          index: item.index - 0.5,
          championMeanReward: null,
          candidateMeanReward: null,
          panelDigest: null,
        },
        item,
      ];
    }
    return [item];
  });
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={290}>
        <ComposedChart data={data} margin={{ top: 14, right: 18, left: -12, bottom: 4 }}>
          <CartesianGrid stroke="#23303d" strokeDasharray="3 5" vertical={false} />
          <XAxis
            dataKey="index"
            stroke="#778797"
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => (Number.isInteger(Number(value)) ? String(value) : "")}
          />
          <YAxis domain={[0, 1]} stroke="#778797" tickLine={false} axisLine={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend iconType="circle" />
          <Line
            type="monotone"
            dataKey="championMeanReward"
            name="Champion"
            stroke="#8c9bab"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="candidateMeanReward"
            name="Candidate"
            stroke="#37d4a5"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CostChart({ points }: { points: PerformancePoint[] }) {
  const data = points.map((point, index) => ({
    ...point,
    index: point.experimentNumber ?? index + 1,
  }));
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={290}>
        <AreaChart data={data} margin={{ top: 14, right: 18, left: -4, bottom: 4 }}>
          <defs>
            <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ad85ff" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#ad85ff" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#23303d" strokeDasharray="3 5" vertical={false} />
          <XAxis dataKey="index" stroke="#778797" tickLine={false} axisLine={false} />
          <YAxis
            stroke="#778797"
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => `$${value}`}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value) => [formatCurrency(Number(value)), "Cumulative spend"]}
          />
          <Area
            dataKey="cumulativeCostUsd"
            type="monotone"
            stroke="#ad85ff"
            strokeWidth={2}
            fill="url(#costFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MiniDelta({ value }: { value?: number | null }) {
  return (
    <span className={(value || 0) >= 0 ? "delta-positive" : "delta-negative"}>
      {formatDelta(value)}
    </span>
  );
}

"use client";

import Script from "next/script";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type ForecastJson = {
  model?: string;
  generated_at?: string;
  latitude?: number;
  longitude?: number;
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    temperature_2m_ecmwf_ifs025?: Array<number | null>;
    temperature_2m_ecmwf_aifs025?: Array<number | null>;
  };
};

type Series = {
  label: string;
  source: string;
  times: string[];
  values: Array<number | null>;
};

type AlignedForecast = {
  labels: string[];
  ifs: Array<number | null>;
  aifs: Array<number | null>;
  deepmind?: Array<number | null>;
};

type LoadState = "idle" | "loading" | "ready" | "error";

declare global {
  interface Window {
    Chart?: new (canvas: HTMLCanvasElement, config: Record<string, unknown>) => {
      destroy: () => void;
    };
  }
}

const DEFAULT_LATITUDE = 25.03;
const DEFAULT_LONGITUDE = 121.56;
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

function formatHourLabel(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function pickSeries(data: ForecastJson, key: keyof NonNullable<ForecastJson["hourly"]>) {
  const hourly = data.hourly ?? {};
  const time = Array.isArray(hourly.time) ? hourly.time : [];
  const values = Array.isArray(hourly[key]) ? hourly[key] : [];

  return { time, values };
}

function seriesToMap(series: Series) {
  const map = new Map<string, number | null>();
  series.times.forEach((time, index) => {
    map.set(time, series.values[index] ?? null);
  });
  return map;
}

function alignForecasts(series: Series[]) {
  const [base] = series;
  const maps = series.map(seriesToMap);
  const commonTimes = base.times.filter((time) =>
    maps.every((map) => map.has(time)),
  );

  return {
    labels: commonTimes,
    values: series.map((_, index) =>
      commonTimes.map((time) => maps[index].get(time) ?? null),
    ),
  };
}

async function fetchForecasts(latitude: number, longitude: number) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "temperature_2m",
    models: "ecmwf_ifs025,ecmwf_aifs025",
    forecast_days: "2",
    timezone: "auto",
  });

  const [openMeteoResult, deepmindResult] = await Promise.all([
    fetch(`${OPEN_METEO_URL}?${params.toString()}`),
    fetch(`/deepmind_forecast.json?ts=${Date.now()}`).then(async (response) => {
      if (!response.ok) {
        throw new Error("DeepMind forecast file is not available.");
      }
      return (await response.json()) as ForecastJson;
    }),
  ].map((promise) => promise.catch((error) => ({ error }))));

  if ("error" in openMeteoResult) {
    throw openMeteoResult.error;
  }

  if (!openMeteoResult.ok) {
    throw new Error(`Open-Meteo request failed: ${openMeteoResult.status}`);
  }

  const openMeteo = (await openMeteoResult.json()) as ForecastJson;
  const ifs = pickSeries(openMeteo, "temperature_2m_ecmwf_ifs025");
  const aifs = pickSeries(openMeteo, "temperature_2m_ecmwf_aifs025");
  const fallback = pickSeries(openMeteo, "temperature_2m");

  const openSeries: Series[] = [
    {
      label: "ECMWF IFS 物理",
      source: "ifs",
      times: ifs.time,
      values: ifs.values.length ? ifs.values : fallback.values,
    },
    {
      label: "ECMWF AIFS 歐洲 AI",
      source: "aifs",
      times: aifs.time,
      values: aifs.values.length ? aifs.values : fallback.values,
    },
  ];

  const deepmind =
    "error" in deepmindResult
      ? null
      : pickSeries(deepmindResult as ForecastJson, "temperature_2m");

  const allSeries = deepmind
    ? [
        ...openSeries,
        {
          label: "Google DeepMind WeatherNext",
          source: "deepmind",
          times: deepmind.time,
          values: deepmind.values,
        },
      ]
    : openSeries;

  let aligned = alignForecasts(allSeries);
  let warning = deepmind ? "" : "DeepMind 離線推論數據未就緒，僅呈現歐洲雙核心";

  if (deepmind && aligned.labels.length === 0) {
    aligned = alignForecasts(openSeries);
    warning = "DeepMind 離線推論數據時間軸未對齊，僅呈現歐洲雙核心";
  }

  return {
    aligned: {
      labels: aligned.labels,
      ifs: aligned.values[0],
      aifs: aligned.values[1],
      deepmind: aligned.values[2],
    } satisfies AlignedForecast,
    warning,
  };
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);
  const [latitude, setLatitude] = useState(String(DEFAULT_LATITUDE));
  const [longitude, setLongitude] = useState(String(DEFAULT_LONGITUDE));
  const [chartReady, setChartReady] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [aligned, setAligned] = useState<AlignedForecast | null>(null);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");

  const pointCount = aligned?.labels.length ?? 0;
  const statusText = useMemo(() => {
    if (loadState === "loading") return "同步中";
    if (loadState === "ready") return `${pointCount} 個共同時間步長已對齊`;
    if (loadState === "error") return "同步失敗";
    return "待同步";
  }, [loadState, pointCount]);

  async function synchronize(event?: FormEvent) {
    event?.preventDefault();
    setLoadState("loading");
    setError("");
    setWarning("");

    const lat = Number(latitude);
    const lon = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setLoadState("error");
      setError("請輸入有效的經緯度數值。");
      return;
    }

    try {
      const result = await fetchForecasts(lat, lon);
      setAligned(result.aligned);
      setWarning(result.warning);
      setUpdatedAt(new Date().toLocaleString("zh-TW", { hour12: false }));
      setLoadState("ready");
    } catch (caught) {
      setLoadState("error");
      setError(caught instanceof Error ? caught.message : "資料同步時發生未知錯誤。");
    }
  }

  useEffect(() => {
    if (!chartReady || !aligned || !canvasRef.current || !window.Chart) {
      return;
    }

    chartRef.current?.destroy();

    chartRef.current = new window.Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: aligned.labels.map(formatHourLabel),
        datasets: [
          {
            label: "ECMWF IFS 物理",
            data: aligned.ifs,
            borderColor: "#0284c7",
            backgroundColor: "rgba(2, 132, 199, 0.12)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.32,
          },
          {
            label: "ECMWF AIFS 歐洲 AI",
            data: aligned.aifs,
            borderColor: "#db2777",
            backgroundColor: "rgba(219, 39, 119, 0.12)",
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.32,
          },
          ...(aligned.deepmind
            ? [
                {
                  label: "Google DeepMind AI",
                  data: aligned.deepmind,
                  borderColor: "#16a34a",
                  backgroundColor: "rgba(22, 163, 74, 0.14)",
                  borderWidth: 3,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                  tension: 0.32,
                },
              ]
            : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          legend: {
            position: "top",
            labels: { boxWidth: 24, boxHeight: 3, color: "#334155" },
          },
          tooltip: {
            callbacks: {
              label: (item: { dataset: { label?: string }; parsed: { y: number } }) =>
                `${item.dataset.label}: ${item.parsed.y.toFixed(1)} °C`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#64748b", maxRotation: 0, autoSkipPadding: 28 },
            grid: { color: "rgba(148, 163, 184, 0.18)" },
          },
          y: {
            title: { display: true, text: "2m 氣溫 (°C)", color: "#475569" },
            ticks: { color: "#64748b" },
            grid: { color: "rgba(148, 163, 184, 0.24)" },
          },
        },
      },
    });

    return () => chartRef.current?.destroy();
  }, [aligned, chartReady]);

  return (
    <main className="dashboard-shell">
      <Script
        src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js"
        strategy="afterInteractive"
        onLoad={() => {
          setChartReady(true);
          void synchronize();
        }}
      />

      <section className="dashboard-header">
        <div>
          <p className="eyebrow">Global Model Comparison</p>
          <h1>全球三核心氣象模型預測對比儀表板</h1>
          <p className="lead">
            以未來 48 小時逐時氣溫作為三方模型交集窗口，將 ECMWF IFS、
            ECMWF AIFS 與 Google DeepMind WeatherNext 對齊到同一條時間軸。
          </p>
        </div>

        <div className={`status-pill ${loadState}`}>
          <span aria-hidden="true" className="status-dot" />
          {statusText}
        </div>
      </section>

      <section className="control-band" aria-label="Forecast controls">
        <form className="controls" onSubmit={synchronize}>
          <label>
            <span>Latitude</span>
            <input
              value={latitude}
              inputMode="decimal"
              onChange={(event) => setLatitude(event.target.value)}
              aria-label="Latitude"
            />
          </label>
          <label>
            <span>Longitude</span>
            <input
              value={longitude}
              inputMode="decimal"
              onChange={(event) => setLongitude(event.target.value)}
              aria-label="Longitude"
            />
          </label>
          <button type="submit" disabled={loadState === "loading" || !chartReady}>
            {loadState === "loading" ? <span className="spinner" aria-hidden="true" /> : null}
            一鍵同步三方模型
          </button>
        </form>

        <div className="meta-grid">
          <div>
            <span>模式</span>
            <strong>標準 48 小時</strong>
          </div>
          <div>
            <span>資料對齊</span>
            <strong>時間戳交集 AND</strong>
          </div>
          <div>
            <span>更新時間</span>
            <strong>{updatedAt || "尚未同步"}</strong>
          </div>
        </div>
      </section>

      {warning ? <div className="warning-banner">{warning}</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <section className="chart-section" aria-label="Hourly temperature comparison">
        <div className="chart-heading">
          <div>
            <h2>逐時 2m 氣溫曲線</h2>
            <p>三條曲線只顯示共同存在的時間點，避免模型預報長度不同造成誤判。</p>
          </div>
          <div className="legend-notes">
            <span className="ifs">IFS</span>
            <span className="aifs">AIFS</span>
            <span className="deepmind">DeepMind</span>
          </div>
        </div>

        <div className="chart-frame">
          {loadState === "loading" ? (
            <div className="chart-loading">
              <span className="spinner large" aria-hidden="true" />
              <span>正在抓取並對齊三方資料</span>
            </div>
          ) : null}
          <canvas ref={canvasRef} aria-label="Hourly temperature line chart" />
        </div>
      </section>
    </main>
  );
}

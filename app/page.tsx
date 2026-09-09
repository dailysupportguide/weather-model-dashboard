"use client";

import Script from "next/script";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  EUROPEAN_MODELS,
  FORECAST_MODE,
  GOOGLE_MODEL,
  UPGRADE_POLICY,
} from "./modelRegistry";

type ForecastJson = {
  model?: string;
  generated_at?: string;
  latitude?: number;
  longitude?: number;
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    [key: string]: string[] | Array<number | null> | undefined;
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
type GeocodeState = "idle" | "searching" | "ready" | "error";

type Place = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  admin2?: string;
  timezone?: string;
};

type GeocodingJson = {
  results?: Place[];
};

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
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

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

function pickSeries(data: ForecastJson, fieldCandidates: readonly string[]) {
  const hourly = data.hourly ?? {};
  const time = Array.isArray(hourly.time) ? hourly.time : [];
  const firstAvailableField = fieldCandidates.find((field) =>
    Array.isArray(hourly[field]),
  );
  const values = firstAvailableField ? hourly[firstAvailableField] : [];

  return {
    time,
    values: Array.isArray(values) ? (values as Array<number | null>) : [],
  };
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
    models: EUROPEAN_MODELS.map((model) => model.modelId).join(","),
    forecast_days: FORECAST_MODE.forecastDays,
    timezone: "auto",
  });

  const [openMeteoResult, deepmindResult] = await Promise.all([
    fetch(`${OPEN_METEO_URL}?${params.toString()}`),
    fetch(`${GOOGLE_MODEL.dataUrl}?ts=${Date.now()}`).then(async (response) => {
      if (!response.ok) {
        throw new Error("Google model forecast file is not available.");
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
  const openSeries: Series[] = EUROPEAN_MODELS.map((model) => {
    const forecast = pickSeries(openMeteo, model.fieldCandidates);

    return {
      label: model.label,
      source: model.key,
      times: forecast.time,
      values: forecast.values,
    };
  });

  const deepmind =
    "error" in deepmindResult
      ? null
      : pickSeries(deepmindResult as ForecastJson, GOOGLE_MODEL.fieldCandidates);

  const allSeries = deepmind
    ? [
        ...openSeries,
        {
          label: GOOGLE_MODEL.label,
          source: GOOGLE_MODEL.key,
          times: deepmind.time,
          values: deepmind.values,
        },
      ]
    : openSeries;

  let aligned = alignForecasts(allSeries);
  let warning = deepmind ? "" : "Google 模型離線推論數據未就緒，僅呈現歐洲雙核心";

  if (deepmind && aligned.labels.length === 0) {
    aligned = alignForecasts(openSeries);
    warning = "Google 模型離線推論數據時間軸未對齊，僅呈現歐洲雙核心";
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

async function searchPlaces(query: string) {
  const params = new URLSearchParams({
    name: query,
    count: "5",
    language: "zh",
    format: "json",
  });
  const response = await fetch(`${GEOCODING_URL}?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`地點搜尋失敗：${response.status}`);
  }

  const data = (await response.json()) as GeocodingJson;
  return data.results ?? [];
}

function formatPlace(place: Place) {
  return [place.name, place.admin2, place.admin1, place.country]
    .filter(Boolean)
    .join(" · ");
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);
  const [locationQuery, setLocationQuery] = useState("台北市");
  const [places, setPlaces] = useState<Place[]>([]);
  const [geocodeState, setGeocodeState] = useState<GeocodeState>("idle");
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

  async function findLocation(event?: FormEvent) {
    event?.preventDefault();

    if (!locationQuery.trim()) {
      setGeocodeState("error");
      setError("請輸入城市或地點名稱。");
      return;
    }

    setGeocodeState("searching");
    setError("");

    try {
      const results = await searchPlaces(locationQuery.trim());
      setPlaces(results);
      setGeocodeState(results.length ? "ready" : "error");

      if (!results.length) {
        setError("找不到符合的地點，請改用更完整的城市或地名。");
      }
    } catch (caught) {
      setGeocodeState("error");
      setError(caught instanceof Error ? caught.message : "地點搜尋時發生未知錯誤。");
    }
  }

  function selectPlace(place: Place) {
    setLocationQuery(formatPlace(place));
    setLatitude(place.latitude.toFixed(5));
    setLongitude(place.longitude.toFixed(5));
    setPlaces([]);
    setGeocodeState("idle");
    void synchronize(undefined, place.latitude, place.longitude);
  }

  async function synchronize(event?: FormEvent, overrideLat?: number, overrideLon?: number) {
    event?.preventDefault();
    setLoadState("loading");
    setError("");
    setWarning("");

    const lat = overrideLat ?? Number(latitude);
    const lon = overrideLon ?? Number(longitude);

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
            label: EUROPEAN_MODELS[0].label,
            data: aligned.ifs,
            ...EUROPEAN_MODELS[0].style,
          },
          {
            label: EUROPEAN_MODELS[1].label,
            data: aligned.aifs,
            ...EUROPEAN_MODELS[1].style,
          },
          ...(aligned.deepmind
            ? [
                {
                  label: GOOGLE_MODEL.label,
                  data: aligned.deepmind,
                  ...GOOGLE_MODEL.style,
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
            ECMWF AIFS 與 Google WeatherNext / GraphCast 對齊到同一條時間軸。
          </p>
        </div>

        <div className={`status-pill ${loadState}`}>
          <span aria-hidden="true" className="status-dot" />
          {statusText}
        </div>
      </section>

      <section className="control-band" aria-label="Forecast controls">
        <form className="location-controls" onSubmit={findLocation}>
          <label>
            <span>地點</span>
            <input
              value={locationQuery}
              onChange={(event) => setLocationQuery(event.target.value)}
              placeholder="輸入城市、地標或行政區"
              aria-label="Location"
            />
          </label>
          <button type="submit" disabled={geocodeState === "searching"}>
            {geocodeState === "searching" ? <span className="spinner" aria-hidden="true" /> : null}
            搜尋地點
          </button>
          {places.length ? (
            <div className="place-results" aria-label="Location search results">
              {places.map((place) => (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => selectPlace(place)}
                  title={`${place.latitude}, ${place.longitude}`}
                >
                  <strong>{place.name}</strong>
                  <span>{[place.admin2, place.admin1, place.country].filter(Boolean).join(" · ")}</span>
                </button>
              ))}
            </div>
          ) : null}
        </form>

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
            <strong>{FORECAST_MODE.label}</strong>
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

      <section className="model-registry" aria-label="Model registry">
        <div>
          <span>歐洲模型</span>
          <strong>{EUROPEAN_MODELS.map((model) => model.modelId).join(" / ")}</strong>
        </div>
        <div>
          <span>Google 模型來源</span>
          <strong>{GOOGLE_MODEL.provider}</strong>
        </div>
        <div>
          <span>升級策略</span>
          <strong>{UPGRADE_POLICY[2]}</strong>
        </div>
      </section>

      <section className="chart-section" aria-label="Hourly temperature comparison">
        <div className="chart-heading">
          <div>
            <h2>逐時 2m 氣溫曲線</h2>
            <p>三條曲線只顯示共同存在的時間點，避免模型預報長度不同造成誤判。</p>
          </div>
          <div className="legend-notes">
            <span className="ifs">IFS</span>
            <span className="aifs">AIFS</span>
            <span className="deepmind">Google AI</span>
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

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
  derived?: boolean;
};

type AlignedForecast = {
  labels: string[];
  ifs: Array<number | null>;
  aifs: Array<number | null>;
  deepmind?: Array<number | null>;
  precipitation: {
    ifs: Array<number | null>;
    aifs: Array<number | null>;
    deepmind?: Array<number | null>;
  };
  precipitationLabels: {
    ifs: string;
    aifs: string;
    deepmind: string;
  };
};

type LoadState = "idle" | "loading" | "ready" | "error";
type GeocodeState = "idle" | "searching" | "ready" | "error";

type Place = {
  id: number | string;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  timezone?: string;
  county?: string;
  source?: "taiwan-town" | "global-city" | "coordinate";
};

type GeocodingJson = {
  results?: Place[];
};

type TaiwanTown = {
  id: string;
  name: string;
  county: string;
  latitude: number;
  longitude: number;
};

type CwaRainCard = {
  date: string;
  time: string;
  probability: string;
};

type CwaRainEntry = {
  id: string;
  tid: string;
  name: string;
  county: string;
  updated_at?: string | null;
  cards: CwaRainCard[];
};

type CwaRainJson = {
  generated_at?: string;
  towns?: Record<string, CwaRainEntry>;
};

type OfficialService = {
  label: string;
  agency: string;
  forecastUrl: string;
  rainUrl: string;
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
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const TAIWAN_TOWNS_URL = "/taiwan_towns.json";
const CWA_RAIN_PROBABILITY_URL = "/cwa_rain_probability.json";
const CWA_TOWN_INDEX_URL = "https://www.cwa.gov.tw/V8/C/W/Town/index.html";
const CWA_TOWN_PAGE_URL = "https://www.cwa.gov.tw/V8/C/W/Town/Town.html";
const OFFICIAL_SERVICES: Record<string, OfficialService> = {
  JP: {
    label: "日本",
    agency: "Japan Meteorological Agency",
    forecastUrl: "https://www.jma.go.jp/bosai/forecast/",
    rainUrl: "https://www.jma.go.jp/bosai/nowc/",
  },
  US: {
    label: "美國",
    agency: "National Weather Service",
    forecastUrl: "https://www.weather.gov/",
    rainUrl: "https://www.wpc.ncep.noaa.gov/qpf/qpf2.shtml",
  },
  GB: {
    label: "英國",
    agency: "Met Office",
    forecastUrl: "https://www.metoffice.gov.uk/weather/forecast/",
    rainUrl: "https://www.metoffice.gov.uk/weather/maps-and-charts/rainfall-radar-forecast-map",
  },
  AU: {
    label: "澳洲",
    agency: "Bureau of Meteorology",
    forecastUrl: "https://www.bom.gov.au/places/",
    rainUrl: "https://www.bom.gov.au/australia/radar/",
  },
  CA: {
    label: "加拿大",
    agency: "Environment and Climate Change Canada",
    forecastUrl: "https://weather.gc.ca/canada_e.html",
    rainUrl: "https://weather.gc.ca/radar/",
  },
  KR: {
    label: "韓國",
    agency: "Korea Meteorological Administration",
    forecastUrl: "https://www.weather.go.kr/w/index.do",
    rainUrl: "https://www.weather.go.kr/w/image/radar.do",
  },
};

let taiwanTownCache: TaiwanTown[] | null = null;

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

function fetchWithTimeout(url: string, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => window.clearTimeout(timer));
}

function hasUsableValues(values: Array<number | null>) {
  return values.some((value) => value !== null && Number.isFinite(value));
}

function precipitationToRainRisk(values: Array<number | null>) {
  return values.map((value) => {
    if (value === null || !Number.isFinite(value)) {
      return null;
    }
    return Math.round(100 * (1 - Math.exp(-Number(value) * 1.25)));
  });
}

function pickRainSeries(data: ForecastJson, probabilityFields: readonly string[], amountFields: readonly string[]) {
  const probability = pickSeries(data, probabilityFields);
  if (hasUsableValues(probability.values)) {
    return { ...probability, derived: false };
  }

  const amount = pickSeries(data, amountFields);
  return {
    time: amount.time,
    values: precipitationToRainRisk(amount.values),
    derived: true,
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
  const now = Date.now();
  const commonTimes = base.times
    .filter((time) => maps.every((map) => map.has(time)))
    .filter((time) => {
      const timestamp = new Date(time).getTime();
      return Number.isFinite(timestamp) && timestamp > now;
    })
    .slice(0, FORECAST_MODE.displayHours);

  return {
    labels: commonTimes,
    values: series.map((_, index) =>
      commonTimes.map((time) => maps[index].get(time) ?? null),
    ),
  };
}

async function fetchForecasts(latitude: number, longitude: number) {
  const europeanParams = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "temperature_2m,precipitation_probability,precipitation",
    models: EUROPEAN_MODELS.map((model) => model.modelId).join(","),
    forecast_hours: FORECAST_MODE.forecastHours,
    timezone: "auto",
  });
  const googleParams = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "temperature_2m,precipitation_probability,precipitation",
    models: GOOGLE_MODEL.modelId,
    forecast_hours: FORECAST_MODE.forecastHours,
    timezone: "auto",
  });

  const [openMeteoResult, deepmindResult] = await Promise.all([
    fetch(`${OPEN_METEO_URL}?${europeanParams.toString()}`),
    fetchWithTimeout(`${GOOGLE_MODEL.endpoint}?${googleParams.toString()}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Google WeatherNext API is not available.");
        }
        return (await response.json()) as ForecastJson;
      })
      .catch(() =>
        fetch(`${GOOGLE_MODEL.fallbackDataUrl}?ts=${Date.now()}`).then(
          async (response) => {
            if (!response.ok) {
              throw new Error("Google model forecast file is not available.");
            }
            return (await response.json()) as ForecastJson;
          },
        ),
      ),
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
  const openPrecipitationSeries: Series[] = EUROPEAN_MODELS.map((model) => {
    const forecast = pickRainSeries(
      openMeteo,
      [
      `precipitation_probability_${model.modelId}`,
      "precipitation_probability",
      ],
      [`precipitation_${model.modelId}`, "precipitation"],
    );

    return {
      label: `${model.label}${forecast.derived ? " 降雨風險" : " 降雨機率"}`,
      source: `${model.key}-precipitation`,
      times: forecast.time,
      values: forecast.values,
      derived: forecast.derived,
    };
  });

  const deepmind =
    "error" in deepmindResult
      ? null
      : pickSeries(deepmindResult as ForecastJson, GOOGLE_MODEL.fieldCandidates);
  const googlePrecipitation =
    "error" in deepmindResult
      ? null
      : pickRainSeries(
          deepmindResult as ForecastJson,
          ["precipitation_probability"],
          ["precipitation"],
        );

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
  const precipitationSeries = googlePrecipitation
    ? [
        ...openPrecipitationSeries,
        {
          label: `${GOOGLE_MODEL.label}${
            googlePrecipitation.derived ? " 降雨風險" : " 降雨機率"
          }`,
          source: `${GOOGLE_MODEL.key}-precipitation`,
          times: googlePrecipitation.time,
          values: googlePrecipitation.values,
          derived: googlePrecipitation.derived,
        },
      ]
    : openPrecipitationSeries;
  let precipitationAligned = alignForecasts(precipitationSeries);
  let warning = deepmind ? "" : "WNC 離線推論數據未就緒，僅呈現歐洲雙核心";

  if (deepmind && aligned.labels.length === 0) {
    aligned = alignForecasts(openSeries);
    precipitationAligned = alignForecasts(openPrecipitationSeries);
    warning = "WNC 離線推論數據時間軸未對齊，僅呈現歐洲雙核心";
  }

  return {
    aligned: {
      labels: aligned.labels,
      ifs: aligned.values[0],
      aifs: aligned.values[1],
      deepmind: aligned.values[2],
      precipitation: {
        ifs: precipitationAligned.values[0] ?? [],
        aifs: precipitationAligned.values[1] ?? [],
        deepmind: precipitationAligned.values[2],
      },
      precipitationLabels: {
        ifs: precipitationSeries[0]?.label ?? `${EUROPEAN_MODELS[0].label} 降雨機率`,
        aifs: precipitationSeries[1]?.label ?? `${EUROPEAN_MODELS[1].label} 降雨機率`,
        deepmind: precipitationSeries[2]?.label ?? `${GOOGLE_MODEL.label} 降雨機率`,
      },
    } satisfies AlignedForecast,
    warning,
  };
}

async function searchPlaces(query: string) {
  const taiwanMatches = await searchTaiwanTowns(query);
  const params = new URLSearchParams({
    name: query,
    count: taiwanMatches.length ? "6" : "8",
    language: "zh",
    format: "json",
  });
  const response = await fetch(`${GEOCODING_URL}?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`地點搜尋失敗：${response.status}`);
  }

  const data = (await response.json()) as GeocodingJson;
  const globalResults = (data.results ?? [])
    .filter((place) => place.country_code !== "TW")
    .slice(0, taiwanMatches.length ? 3 : 6)
    .map((place) => ({ ...place, source: "global-city" as const }));

  return [...taiwanMatches, ...globalResults];
}

async function lookupPlaceCoordinate(query: string) {
  const places = await searchPlaces(query);
  if (places.length) return places[0];

  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    "accept-language": "zh-TW,zh,en",
  });
  const response = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`地標座標查詢失敗：${response.status}`);
  }

  const results = (await response.json()) as Array<{
    display_name?: string;
    lat?: string;
    lon?: string;
  }>;
  const result = results[0];
  const latitude = Number(result?.lat);
  const longitude = Number(result?.lon);
  if (!result || !validCoordinates(latitude, longitude)) return null;

  return {
    id: `osm-${latitude.toFixed(5)}-${longitude.toFixed(5)}`,
    name: result.display_name?.split(",")[0] || query,
    country: result.display_name || "",
    country_code: "",
    source: "coordinate" as const,
    latitude,
    longitude,
  } satisfies Place;
}

async function searchTaiwanTowns(query: string) {
  const normalizedQuery = normalizeTaiwanText(query);
  const shouldPreferTaiwan =
    /[\u4e00-\u9fff]/.test(query) ||
    /taiwan|tw|taipei|taichung|tainan|kaohsiung|hsinchu|keelung|chiayi|miaoli|changhua|nantou|yunlin|pingtung|yilan|hualien|taitung|penghu|kinmen|lienchiang/i.test(
      query,
    );

  if (!shouldPreferTaiwan) {
    return [];
  }

  if (!taiwanTownCache) {
    const response = await fetch(`${TAIWAN_TOWNS_URL}?ts=20260910`);
    if (!response.ok) {
      return [];
    }
    taiwanTownCache = (await response.json()) as TaiwanTown[];
  }

  return taiwanTownCache
    .filter((town) =>
      normalizeTaiwanText(`${town.county}${town.name}`).includes(normalizedQuery) ||
      normalizeTaiwanText(town.name).includes(normalizedQuery) ||
      normalizeTaiwanText(town.county).includes(normalizedQuery),
    )
    .slice(0, 6)
    .map((town) => ({
      id: town.id,
      name: town.name,
      county: town.county,
      admin1: town.county,
      country: "台灣",
      latitude: town.latitude,
      longitude: town.longitude,
      source: "taiwan-town" as const,
    }));
}

function formatPlace(place: Place) {
  return uniquePlaceParts([place.name, place.county || place.admin2, place.admin1, place.country])
    .filter(Boolean)
    .join(" · ");
}

function uniquePlaceParts(parts: Array<string | undefined>) {
  const seen = new Set<string>();
  return parts.filter((part) => {
    if (!part || seen.has(part)) {
      return false;
    }
    seen.add(part);
    return true;
  });
}

function normalizeTaiwanText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("臺", "台")
    .replace(/\s+/g, "");
}

function getCwaTownTid(place: Place) {
  const id = String(place.id || "");
  if (!/^\d+$/.test(id)) return "";
  if (/^(63|64|65|66|67|68)/.test(id)) {
    return `${id.slice(0, 2)}${id.slice(4, 7)}00`;
  }
  if (/^(090|100)/.test(id)) {
    return id.slice(0, 7);
  }
  return "";
}

function getCwaTownUrl(place: Place) {
  const townTid = getCwaTownTid(place);
  return townTid
    ? `${CWA_TOWN_PAGE_URL}?TID=${encodeURIComponent(townTid)}`
    : CWA_TOWN_INDEX_URL;
}

function toDecimalDegrees(degrees: number, minutes = 0, seconds = 0, direction = "") {
  const value = Math.abs(degrees) + Math.abs(minutes) / 60 + Math.abs(seconds) / 3600;
  return /[SW南西]/i.test(direction) || degrees < 0 ? -value : value;
}

function validCoordinates(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function extractCoordinates(value: string) {
  const normalized = value.trim().replaceAll("，", ",");
  const chineseLatitude = normalized.match(/([北南])緯\s*(\d+(?:\.\d+)?)\s*(?:[°度]\s*(?:(\d+(?:\.\d+)?)\s*(?:[′'分])?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:[″"秒])?)?)?/);
  const chineseLongitude = normalized.match(/([東西])經\s*(\d+(?:\.\d+)?)\s*(?:[°度]\s*(?:(\d+(?:\.\d+)?)\s*(?:[′'分])?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:[″"秒])?)?)?/);
  if (chineseLatitude && chineseLongitude) {
    const latitude = toDecimalDegrees(
      Number(chineseLatitude[2]),
      Number(chineseLatitude[3] || 0),
      Number(chineseLatitude[4] || 0),
      chineseLatitude[1],
    );
    const longitude = toDecimalDegrees(
      Number(chineseLongitude[2]),
      Number(chineseLongitude[3] || 0),
      Number(chineseLongitude[4] || 0),
      chineseLongitude[1],
    );
    if (validCoordinates(latitude, longitude)) return { latitude, longitude };
  }

  const directionalDecimal = normalized.match(
    /(-?\d+(?:\.\d+)?)\s*°?\s*([NS北南])\s*[, ]+\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW東西])/i,
  );
  if (directionalDecimal) {
    const latitude = toDecimalDegrees(Number(directionalDecimal[1]), 0, 0, directionalDecimal[2]);
    const longitude = toDecimalDegrees(Number(directionalDecimal[3]), 0, 0, directionalDecimal[4]);
    if (validCoordinates(latitude, longitude)) return { latitude, longitude };
  }

  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /(?:lat(?:itude)?\s*[:=]?\s*)?(-?\d+(?:\.\d+)?)\s*,\s*(?:lon(?:gitude)?\s*[:=]?\s*)?(-?\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (validCoordinates(lat, lon)) {
      return { latitude: lat, longitude: lon };
    }
  }

  return null;
}

export default function Home() {
  const temperatureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const precipitationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const temperatureChartRef = useRef<{ destroy: () => void } | null>(null);
  const precipitationChartRef = useRef<{ destroy: () => void } | null>(null);
  const [locationQuery, setLocationQuery] = useState("台北市");
  const [places, setPlaces] = useState<Place[]>([]);
  const [geocodeState, setGeocodeState] = useState<GeocodeState>("idle");
  const [latitude, setLatitude] = useState(String(DEFAULT_LATITUDE));
  const [longitude, setLongitude] = useState(String(DEFAULT_LONGITUDE));
  const [googleCoordinateQuery, setGoogleCoordinateQuery] = useState("");
  const [googleCoordinateInput, setGoogleCoordinateInput] = useState("");
  const [chartReady, setChartReady] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [aligned, setAligned] = useState<AlignedForecast | null>(null);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [cwaRainEntry, setCwaRainEntry] = useState<CwaRainEntry | null>(null);
  const [cwaRainGeneratedAt, setCwaRainGeneratedAt] = useState("");
  const [cwaRainLoading, setCwaRainLoading] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<Place>({
    id: "default-taipei",
    name: "台北市",
    county: "台北市",
    country: "台灣",
    country_code: "TW",
    source: "taiwan-town",
    latitude: DEFAULT_LATITUDE,
    longitude: DEFAULT_LONGITUDE,
  });

  const pointCount = aligned?.labels.length ?? 0;
  const statusText = useMemo(() => {
    if (loadState === "loading") return "同步中";
    if (loadState === "ready") return `${pointCount} 個未來共同時間步長已對齊`;
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
    setSelectedPlace(place);
    setGeocodeState("idle");
    void synchronize(undefined, place.latitude, place.longitude);
  }

  function syncCoordinates(event: FormEvent) {
    event.preventDefault();
    const lat = Number(latitude);
    const lon = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setLoadState("error");
      setError("請輸入有效的經緯度數值。");
      return;
    }

    const coordinatePlace: Place = {
      id: `coordinate-${lat.toFixed(5)}-${lon.toFixed(5)}`,
      name: "經緯度查詢",
      country: "",
      country_code: "",
      source: "coordinate",
      latitude: lat,
      longitude: lon,
    };

    setPlaces([]);
    setLocationQuery(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    setSelectedPlace(coordinatePlace);
    void synchronize(undefined, lat, lon);
  }

  async function lookupCoordinatesInBackground(event: FormEvent) {
    event.preventDefault();
    const query = googleCoordinateQuery.trim() || locationQuery.trim();
    if (!query) {
      setError("請輸入要查詢經緯度的地點。");
      return;
    }

    try {
      const place = await lookupPlaceCoordinate(query);
      if (!place) {
        setError("找不到座標，請改貼 Google Maps 網址或 Google 顯示的經緯度文字。");
        return;
      }

      setError("");
      setLatitude(place.latitude.toFixed(5));
      setLongitude(place.longitude.toFixed(5));
      setGoogleCoordinateInput(`${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "查詢座標時發生未知錯誤。");
    }
  }

  function applyGoogleCoordinateInput(event: FormEvent) {
    event.preventDefault();
    const coordinates = extractCoordinates(googleCoordinateInput);
    if (!coordinates) {
      setError("無法辨識座標，請貼上 Google Maps 網址或 25.03300, 121.56500 這種格式。");
      return;
    }

    setError("");
    setLatitude(coordinates.latitude.toFixed(5));
    setLongitude(coordinates.longitude.toFixed(5));
  }

  function updateGoogleCoordinateInput(value: string) {
    setGoogleCoordinateInput(value);
    const coordinates = extractCoordinates(value);
    if (!coordinates) return;
    setLatitude(coordinates.latitude.toFixed(5));
    setLongitude(coordinates.longitude.toFixed(5));
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
    if (!chartReady || !aligned || !temperatureCanvasRef.current || !window.Chart) {
      return;
    }

    temperatureChartRef.current?.destroy();

    temperatureChartRef.current = new window.Chart(temperatureCanvasRef.current, {
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

    return () => temperatureChartRef.current?.destroy();
  }, [aligned, chartReady]);

  useEffect(() => {
    if (!chartReady || !aligned || !precipitationCanvasRef.current || !window.Chart) {
      return;
    }

    precipitationChartRef.current?.destroy();

    precipitationChartRef.current = new window.Chart(precipitationCanvasRef.current, {
      type: "line",
      data: {
        labels: aligned.labels.map(formatHourLabel),
        datasets: [
          {
            label: aligned.precipitationLabels.ifs,
            data: aligned.precipitation.ifs,
            ...EUROPEAN_MODELS[0].style,
          },
          {
            label: aligned.precipitationLabels.aifs,
            data: aligned.precipitation.aifs,
            ...EUROPEAN_MODELS[1].style,
          },
          ...(aligned.precipitation.deepmind
            ? [
                {
                  label: aligned.precipitationLabels.deepmind,
                  data: aligned.precipitation.deepmind,
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
                `${item.dataset.label}: ${item.parsed.y.toFixed(0)}%`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#64748b", maxRotation: 0, autoSkipPadding: 28 },
            grid: { color: "rgba(148, 163, 184, 0.18)" },
          },
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: "降雨機率 / 風險 (%)", color: "#475569" },
            ticks: { color: "#64748b" },
            grid: { color: "rgba(148, 163, 184, 0.24)" },
          },
        },
      },
    });

    return () => precipitationChartRef.current?.destroy();
  }, [aligned, chartReady]);

  const isTaiwanPlace =
    selectedPlace.source === "taiwan-town" ||
    selectedPlace.country_code === "TW" ||
    selectedPlace.country === "台灣" ||
    selectedPlace.country === "台湾";
  const officialService = selectedPlace.country_code
    ? OFFICIAL_SERVICES[selectedPlace.country_code]
    : undefined;
  const cwaTownUrl = getCwaTownUrl(selectedPlace);
  const selectedCwaTid = isTaiwanPlace ? getCwaTownTid(selectedPlace) : "";
  const activeCwaRainEntry =
    selectedCwaTid && cwaRainEntry?.tid === selectedCwaTid ? cwaRainEntry : null;

  useEffect(() => {
    if (!selectedCwaTid) {
      return;
    }

    const controller = new AbortController();

    async function loadCwaRain() {
      setCwaRainLoading(true);
      try {
        const response = await fetch(`${CWA_RAIN_PROBABILITY_URL}?ts=20260910`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`CWA rain data failed: ${response.status}`);
        const data = (await response.json()) as CwaRainJson;
        setCwaRainEntry(data.towns?.[selectedCwaTid] ?? null);
        setCwaRainGeneratedAt(data.generated_at ?? "");
      } catch {
        if (!controller.signal.aborted) {
          setCwaRainEntry(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setCwaRainLoading(false);
        }
      }
    }

    void loadCwaRain();

    return () => controller.abort();
  }, [selectedCwaTid]);

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
            輸入地點即可同步三大模型；台灣支援鄉鎮市區，其他地區以城市搜尋。
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
              placeholder="台灣可輸入鄉鎮市區，國外輸入城市"
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
                  <span>
                    {uniquePlaceParts([
                      place.source === "taiwan-town" ? "鄉鎮市區" : "城市",
                      place.county || place.admin2,
                      place.admin1,
                      place.country,
                    ])
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </form>

        <details className="coordinate-panel">
          <summary>使用經緯度查詢</summary>
          <form className="google-coordinate-controls" onSubmit={lookupCoordinatesInBackground}>
            <label>
              <span>地點查座標</span>
              <input
                value={googleCoordinateQuery}
                onChange={(event) => setGoogleCoordinateQuery(event.target.value)}
                placeholder="輸入地點快速查經緯度"
                aria-label="Coordinate lookup"
              />
            </label>
            <button type="submit">後台查座標</button>
          </form>
          <form className="google-coordinate-controls" onSubmit={applyGoogleCoordinateInput}>
            <label>
              <span>貼上座標或 Google Maps 網址</span>
              <input
                value={googleCoordinateInput}
                onChange={(event) => updateGoogleCoordinateInput(event.target.value)}
                placeholder="北緯 34°36′59″、東經 135°01′13″"
                aria-label="Paste Google coordinates"
              />
            </label>
            <button type="submit">整理座標</button>
          </form>
          <form className="coordinate-controls" onSubmit={syncCoordinates}>
            <label>
              <span>Latitude</span>
              <input
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
                inputMode="decimal"
                aria-label="Latitude"
              />
            </label>
            <label>
              <span>Longitude</span>
              <input
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
                inputMode="decimal"
                aria-label="Longitude"
              />
            </label>
            <button type="submit">套用經緯度</button>
          </form>
          <p className="coordinate-note">後台地標查詢輔助來源：Open-Meteo Geocoding / OpenStreetMap Nominatim。</p>
        </details>

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

      <section className="official-section" aria-label="Official weather forecast">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">Official Forecast</p>
            <h2>{formatPlace(selectedPlace)} 官方氣象預報</h2>
          </div>
        </div>

        {isTaiwanPlace ? (
          <div className="official-grid taiwan">
            <article className="official-card">
              <div>
                <span>中央氣象署</span>
                <h3>CWA 72 小時降雨機率</h3>
              </div>
              <div>
                <p className="cwa-rain-meta">
                  {cwaRainLoading
                    ? "載入 CWA 降雨機率中。"
                    : activeCwaRainEntry
                      ? `${activeCwaRainEntry.county}${activeCwaRainEntry.name}，資料時間：${
                          activeCwaRainEntry.updated_at || cwaRainGeneratedAt
                        }`
                      : "目前尚未取得 CWA 72 小時降雨機率資料。"}
                </p>
                {activeCwaRainEntry?.cards?.length ? (
                  <div className="cwa-rain-cards">
                    {activeCwaRainEntry.cards.map((card) => (
                      <article className="cwa-rain-card" key={`${card.date}-${card.time}`}>
                        <span className="cwa-card-date">{card.date}</span>
                        <span className="cwa-card-time">{card.time}</span>
                        <strong>{card.probability}</strong>
                      </article>
                    ))}
                  </div>
                ) : null}
              </div>
              <a href={cwaTownUrl} target="_blank" rel="noreferrer">
                開啟 CWA 預報
              </a>
            </article>
          </div>
        ) : (
          <div className="official-grid">
            <article className="official-card link-only">
              <div>
                <span>{officialService?.label || selectedPlace.country || "Global"}</span>
                <h3>{officialService?.agency || "官方氣象服務入口"}</h3>
                <p>依所選城市查詢當地官方天氣與降雨預報。</p>
              </div>
              <a
                href={officialService?.forecastUrl || "https://public.wmo.int/en/about-us/members"}
                target="_blank"
                rel="noreferrer"
              >
                開啟官方預報
              </a>
            </article>
            <article className="official-card link-only">
              <div>
                <span>Rain Forecast</span>
                <h3>官方降雨預報</h3>
                <p>優先連到該國氣象單位的雷達、QPF 或降雨預報頁。</p>
              </div>
              <a
                href={officialService?.rainUrl || "https://public.wmo.int/en/about-us/members"}
                target="_blank"
                rel="noreferrer"
              >
                開啟降雨預報
              </a>
            </article>
          </div>
        )}
      </section>

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
            <h2>逐時 2m 氣溫比較</h2>
            <p>僅顯示三方共同時間點，手機上可橫向滑動查看細節。</p>
          </div>
          <div className="legend-notes">
            <span className="ifs">歐洲傳統</span>
            <span className="aifs">歐洲AI</span>
            <span className="deepmind">WNC</span>
          </div>
        </div>

        <div className="chart-frame">
          {loadState === "loading" ? (
            <div className="chart-loading">
              <span className="spinner large" aria-hidden="true" />
              <span>正在抓取並對齊三方資料</span>
            </div>
          ) : null}
          <canvas ref={temperatureCanvasRef} aria-label="Hourly temperature line chart" />
        </div>

        <div className="chart-subheading">
          <h3>逐時降雨機率 / 風險</h3>
        </div>
        <div className="chart-frame compact">
          <canvas ref={precipitationCanvasRef} aria-label="Hourly precipitation probability line chart" />
        </div>
      </section>
    </main>
  );
}

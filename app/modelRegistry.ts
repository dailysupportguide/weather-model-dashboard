export const FORECAST_MODE = {
  id: "standard-48h",
  label: "未來 48 小時",
  forecastHours: "48",
  timestep: "hourly",
};

export const EUROPEAN_MODELS = [
  {
    key: "ifs",
    label: "ECMWF IFS 物理",
    provider: "Open-Meteo",
    modelId: "ecmwf_ifs025",
    fieldCandidates: ["temperature_2m_ecmwf_ifs025", "temperature_2m"],
    style: {
      borderColor: "#0284c7",
      backgroundColor: "rgba(2, 132, 199, 0.12)",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.32,
    },
  },
  {
    key: "aifs",
    label: "ECMWF AIFS 歐洲 AI",
    provider: "Open-Meteo",
    modelId: "ecmwf_aifs025_single",
    fieldCandidates: ["temperature_2m_ecmwf_aifs025_single", "temperature_2m"],
    style: {
      borderColor: "#db2777",
      backgroundColor: "rgba(219, 39, 119, 0.12)",
      borderDash: [5, 5],
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.32,
    },
  },
] as const;

export const GOOGLE_MODEL = {
  key: "google",
  label: "Google WeatherNext 2",
  provider: "Open-Meteo Google WeatherNext 2 API",
  endpoint: "https://ensemble-api.open-meteo.com/v1/ensemble",
  modelId: "google_weathernext2_ensemble_mean",
  fallbackDataUrl: "/deepmind_forecast.json",
  fieldCandidates: ["temperature_2m"],
  style: {
    borderColor: "#16a34a",
    backgroundColor: "rgba(22, 163, 74, 0.14)",
    borderWidth: 3,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0.32,
  },
} as const;

export const UPGRADE_POLICY = [
  "歐洲模型：更新 Open-Meteo modelId 與 fieldCandidates 即可切換新版本。",
  "Google 模型：優先檢查 Open-Meteo WeatherNext API；Colab adapter 作為自建推論備援。",
  "表格對齊：永遠以啟用模型的共同時間戳交集顯示，避免新舊模型預報長度不同。",
];

export const FORECAST_MODE = {
  id: "standard-48h",
  label: "標準 48 小時",
  forecastDays: "2",
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
    modelId: "ecmwf_aifs025",
    fieldCandidates: ["temperature_2m_ecmwf_aifs025", "temperature_2m"],
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
  label: "Google WeatherNext / GraphCast",
  provider: "Self-hosted Colab or authorized Google source",
  dataUrl: "/deepmind_forecast.json",
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
  "Google 模型：更新 dataUrl 或 Colab adapter，可切換 WeatherNext / GraphCast 新資料源。",
  "圖表對齊：永遠以啟用模型的共同時間戳交集顯示，避免新舊模型預報長度不同。",
];

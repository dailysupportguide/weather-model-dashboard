# 全球三核心氣象模型預測對比儀表板

這是一個輕量 SPA 儀表板，用 Chart.js 將 ECMWF IFS、ECMWF AIFS 與 Google DeepMind WeatherNext 的逐時 2m 氣溫預測對齊到同一時間軸。

## 功能

- 以 Open-Meteo Forecast API 直接抓取 `ecmwf_ifs025` 與 `ecmwf_aifs025`
- 以 Open-Meteo Geocoding API 搜尋城市或地點並自動帶入經緯度
- 從 `public/deepmind_forecast.json` 讀取 DeepMind 離線推論結果
- 以時間戳交集裁切三方資料，預設對齊未來 48 小時逐時預報
- DeepMind JSON 缺失或時間軸不匹配時，自動降級顯示歐洲雙核心並顯示警告
- 以 `app/modelRegistry.ts` 管理模型來源，方便未來切換新版 ECMWF 或 Google WeatherNext / GraphCast 資料源

## 本機執行

```bash
pnpm install
pnpm run dev
```

## 模型升級

模型版本集中在 `app/modelRegistry.ts`：

- 歐洲模型更新時，修改 `EUROPEAN_MODELS[].modelId` 與 `fieldCandidates`
- Google 模型更新時，修改 `GOOGLE_MODEL.dataUrl`，或在 Colab notebook 的 `run_deepmind_adapter()` 改接新版 WeatherNext / GraphCast
- 前端對齊邏輯不需要重寫，仍會以啟用模型的共同時間戳交集作圖

## 更新 DeepMind JSON

```bash
python scripts/generate_deepmind_forecast.py --latitude 25.03 --longitude 121.56 --hours 48
```

## Colab Notebook

`notebooks/deepmind_weather_forecast_colab.ipynb` 可上傳到 Google Colab 執行。它會產生 `deepmind_forecast.json`、保存一份到 Google Drive，並提供可選的 GitHub 回推流程。

目前腳本會產生符合前端 schema 的 deterministic placeholder。接入真實 WeatherNext 或 GraphCast 時，保留輸出結構即可：

```json
{
  "model": "Google DeepMind WeatherNext",
  "generated_at": "2026-09-09T00:00:00Z",
  "latitude": 25.03,
  "longitude": 121.56,
  "hourly": {
    "time": ["2026-09-09T00:00"],
    "temperature_2m": [26.5]
  }
}
```

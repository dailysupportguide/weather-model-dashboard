"""Generate public/deepmind_forecast.json for the forecast dashboard.

This script is intentionally structured so a real WeatherNext or GraphCast
adapter can replace the deterministic placeholder forecast in CI or Colab.
The operational model path requires large atmospheric input tensors and model
weights, so the default implementation emits schema-valid sample data.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path


def build_placeholder_forecast(latitude: float, longitude: float, hours: int) -> dict:
    generated_at = datetime.now(timezone.utc).replace(
        minute=0, second=0, microsecond=0
    )
    local_hour_offset = round(longitude / 15)
    local_now = (generated_at + timedelta(hours=local_hour_offset)).replace(tzinfo=None)
    start = local_now.replace(hour=0)
    times: list[str] = []
    temperatures: list[float] = []

    for step in range(hours):
        timestamp = start + timedelta(hours=step)
        local_hour = (timestamp.hour + local_hour_offset) % 24
        daytime_wave = math.sin(((local_hour - 7) / 24) * 2 * math.pi)
        synoptic_wave = math.sin((step / 18) * 2 * math.pi) * 0.4
        latitude_adjustment = max(-4.0, min(4.0, (25 - abs(latitude)) * 0.05))
        temperature = 29.4 + daytime_wave * 3.1 + synoptic_wave + latitude_adjustment

        times.append(timestamp.strftime("%Y-%m-%dT%H:00"))
        temperatures.append(round(temperature, 1))

    return {
        "model": "Google DeepMind WeatherNext",
        "generated_at": generated_at.isoformat().replace("+00:00", "Z"),
        "latitude": latitude,
        "longitude": longitude,
        "hourly": {
            "time": times,
            "temperature_2m": temperatures,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--latitude", type=float, default=25.03)
    parser.add_argument("--longitude", type=float, default=121.56)
    parser.add_argument("--hours", type=int, default=48)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public") / "deepmind_forecast.json",
    )
    args = parser.parse_args()

    forecast = build_placeholder_forecast(args.latitude, args.longitude, args.hours)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(forecast, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()

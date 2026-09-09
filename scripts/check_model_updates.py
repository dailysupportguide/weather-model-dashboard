"""Check official model sources and optionally adopt compatible updates.

The script is conservative by design. API model ids can be auto-adopted only
when they match an allowed family and a live API probe returns hourly 2m
temperature fields. Google open-source releases are reported because weights,
input data, and adapter code must be validated before switching.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "scripts" / "model_update_policy.json"
REGISTRY_PATH = ROOT / "app" / "modelRegistry.ts"
REPORT_PATH = ROOT / "public" / "model_update_report.json"
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GITHUB_API = "https://api.github.com/repos/{repo}/releases/latest"


def fetch_text(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "weather-model-dashboard-update-monitor/1.0",
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def discover_models(docs_url: str, prefix: str) -> list[str]:
    text = fetch_text(docs_url)
    raw_models = re.findall(rf"\b{re.escape(prefix)}[a-z0-9_]+\b", text, flags=re.IGNORECASE)
    models = set()

    for model in raw_models:
        cleaned = model.lower()
        for suffix in ("_model_label", "_single_model_label", "_single_model", "_model", "_label"):
            if cleaned.endswith(suffix):
                cleaned = cleaned[: -len(suffix)]
                break
        models.add(cleaned)

    return sorted(model.lower() for model in models)


def probe_api_model(
    model_id: str,
    probe: dict[str, Any],
    endpoint: str = OPEN_METEO_FORECAST_URL,
) -> dict[str, Any]:
    params = {
        "latitude": probe["latitude"],
        "longitude": probe["longitude"],
        "forecast_days": probe["forecast_days"],
        "hourly": probe["hourly"],
        "models": model_id,
        "timezone": "auto",
    }
    url = f"{endpoint}?{urllib.parse.urlencode(params)}"

    try:
        payload = json.loads(fetch_text(url))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"model_id": model_id, "ok": False, "error": str(exc)}

    hourly = payload.get("hourly", {})
    field_names = [name for name in hourly.keys() if name.startswith("temperature_2m")]
    time = hourly.get("time", [])
    ok = bool(field_names and time)

    return {
        "model_id": model_id,
        "ok": ok,
        "field_names": field_names,
        "timesteps": len(time) if isinstance(time, list) else 0,
    }


def choose_latest_compatible(
    discovered: list[str],
    slot: dict[str, Any],
    probe: dict[str, Any],
    endpoint: str = OPEN_METEO_FORECAST_URL,
) -> dict[str, Any]:
    pattern = re.compile(slot["allowed_model_pattern"])
    candidates = [model for model in discovered if pattern.search(model)]
    current = slot["current_model_id"]

    if current not in candidates:
        candidates.append(current)

    probed = [
        probe_api_model(model, probe, endpoint)
        for model in sorted(set(candidates))
    ]
    compatible = [item["model_id"] for item in probed if item.get("ok")]
    selected = sorted(compatible)[-1] if compatible else current

    return {
        "key": slot["key"],
        "label": slot["label"],
        "current_model_id": current,
        "endpoint": endpoint,
        "compatible_models": compatible,
        "selected_model_id": selected,
        "would_update": selected != current,
        "probe_results": probed,
    }


def get_latest_github_release(repo: str) -> dict[str, Any]:
    url = GITHUB_API.format(repo=repo)
    try:
        payload = json.loads(fetch_text(url))
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as exc:
        return {"repo": repo, "ok": False, "error": str(exc)}

    return {
        "repo": repo,
        "ok": True,
        "tag_name": payload.get("tag_name"),
        "name": payload.get("name"),
        "published_at": payload.get("published_at"),
        "html_url": payload.get("html_url"),
    }


def update_registry(open_meteo_checks: list[dict[str, Any]]) -> bool:
    text = REGISTRY_PATH.read_text(encoding="utf-8")
    updated = text

    for check in open_meteo_checks:
        if not check["would_update"]:
            continue
        updated = updated.replace(
            f'modelId: "{check["current_model_id"]}"',
            f'modelId: "{check["selected_model_id"]}"',
        )
        updated = updated.replace(
            f'"temperature_2m_{check["current_model_id"]}"',
            f'"temperature_2m_{check["selected_model_id"]}"',
        )

    if updated == text:
        return False

    REGISTRY_PATH.write_text(updated, encoding="utf-8")
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--auto-adopt-compatible",
        action="store_true",
        help="Update app/modelRegistry.ts for compatible Open-Meteo model ids.",
    )
    args = parser.parse_args()

    policy = load_json(POLICY_PATH)
    discovered = discover_models(policy["open_meteo"]["docs_url"], "ecmwf_")
    open_meteo_checks = [
        choose_latest_compatible(discovered, slot, policy["open_meteo"]["probe"])
        for slot in policy["open_meteo"]["slots"]
    ]
    google_api_models = discover_models(
        policy["google_weather"]["open_meteo_docs_url"],
        "google_weathernext",
    )
    google_api_check = choose_latest_compatible(
        google_api_models,
        policy["google_weather"]["api_slot"],
        policy["open_meteo"]["probe"],
        policy["google_weather"]["api_slot"]["endpoint"],
    )
    google_release = get_latest_github_release(policy["google_weather"]["github_repo"])
    registry_updated = (
        update_registry([*open_meteo_checks, google_api_check])
        if args.auto_adopt_compatible
        else False
    )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "auto_adopt_compatible": args.auto_adopt_compatible,
        "registry_updated": registry_updated,
        "open_meteo": {
            "docs_url": policy["open_meteo"]["docs_url"],
            "discovered_ecmwf_models": discovered,
            "checks": open_meteo_checks,
        },
        "google_weather": {
            **policy["google_weather"],
            "discovered_api_models": google_api_models,
            "api_check": google_api_check,
            "latest_open_source_release": google_release,
            "requires_manual_adapter_validation": True,
        },
    }

    REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

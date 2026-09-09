"""Generate CWA 72-hour rain probability cards for Taiwan towns."""

from __future__ import annotations

import argparse
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen


CWA_MOD_URL = "https://www.cwa.gov.tw/V8/C/W/Town/MOD/3hr/{tid}_3hr_PC.html"


def cwa_tid(town_id: str) -> str:
    if not town_id.isdigit():
        return ""
    if town_id.startswith(("63", "64", "65", "66", "67", "68")):
        return f"{town_id[:2]}{town_id[4:7]}00"
    if town_id.startswith(("090", "100")):
        return town_id[:7]
    return ""


@dataclass
class Cell:
    tag: str
    attrs: dict[str, str]
    text: str = ""


@dataclass
class Row:
    cells: list[Cell] = field(default_factory=list)


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[Row] = []
        self.current_row: Row | None = None
        self.current_cell: Cell | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self.current_row = Row()
        elif tag in {"th", "td"} and self.current_row is not None:
            self.current_cell = Cell(tag=tag, attrs={key: value or "" for key, value in attrs})

    def handle_data(self, data: str) -> None:
        if self.current_cell is not None:
            self.current_cell.text += data

    def handle_endtag(self, tag: str) -> None:
        if tag in {"th", "td"} and self.current_cell is not None and self.current_row is not None:
            self.current_cell.text = re.sub(r"\s+", " ", self.current_cell.text).strip()
            self.current_row.cells.append(self.current_cell)
            self.current_cell = None
        elif tag == "tr" and self.current_row is not None:
            if self.current_row.cells:
                self.rows.append(self.current_row)
            self.current_row = None


def fetch_text(url: str, timeout: int) -> tuple[str, str | None]:
    request = Request(url, headers={"User-Agent": "weather-model-dashboard/1.0"})
    with urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        updated = response.headers.get("Last-Modified")
        return response.read().decode(charset, errors="replace"), updated


def parse_cwa_rain_cards(html: str) -> list[dict[str, str]]:
    parser = TableParser()
    parser.feed(html)

    date_by_day: dict[str, str] = {}
    time_by_id: dict[str, str] = {}
    rain_cards: list[dict[str, str]] = []

    for row in parser.rows:
        first_id = row.cells[0].attrs.get("id", "") if row.cells else ""

        if first_id == "PC3_D":
            for cell in row.cells[1:]:
                cell_id = cell.attrs.get("id", "")
                if cell_id:
                    date_by_day[cell_id] = normalize_date_label(cell.text)

        if first_id == "PC3_Ti":
            for cell in row.cells[1:]:
                cell_id = cell.attrs.get("id", "")
                if cell_id:
                    time_by_id[cell_id] = cell.text.strip()

        if first_id == "PC3_Po":
            for cell in row.cells[1:]:
                probability = cell.text.strip()
                hour_ids = re.findall(r"PC3_D\d+H\d{2}", cell.attrs.get("headers", ""))
                if not hour_ids:
                    continue

                first_hour_id = hour_ids[0]
                last_hour_id = hour_ids[-1]
                day_match = re.match(r"(PC3_D\d+)H\d{2}", first_hour_id)
                day_label = date_by_day.get(day_match.group(1), "") if day_match else ""
                start_time = time_by_id.get(first_hour_id, "")
                end_time = time_by_id.get(last_hour_id, start_time)
                time_label = start_time if start_time == end_time else f"{start_time}-{end_time}"
                rain_cards.append(
                    {
                        "date": day_label,
                        "time": time_label,
                        "probability": probability,
                    }
                )

    return rain_cards


def normalize_date_label(value: str) -> str:
    text = re.sub(r"\s+", " ", value).strip()
    return re.sub(r"^(\d{2}/\d{2})(.+)$", r"\1 \2", text)


def generate(towns_path: Path, output_path: Path, limit: int | None, delay: float, timeout: int) -> dict[str, Any]:
    towns = json.loads(towns_path.read_text(encoding="utf-8"))
    if limit is not None:
        towns = towns[:limit]

    output: dict[str, Any] = {
        "source": "Central Weather Administration 72-hour town forecast",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "towns": {},
    }

    for index, town in enumerate(towns, start=1):
        tid = cwa_tid(str(town["id"]))
        if not tid:
            continue

        try:
            html, updated_at = fetch_text(CWA_MOD_URL.format(tid=tid), timeout)
            cards = parse_cwa_rain_cards(html)
        except Exception as error:  # noqa: BLE001 - keep batch generation resilient.
            cards = []
            updated_at = None
            print(f"[warn] {town['county']}{town['name']} {tid}: {error}")

        output["towns"][tid] = {
            "id": town["id"],
            "tid": tid,
            "name": town["name"],
            "county": town["county"],
            "updated_at": updated_at,
            "cards": cards,
        }

        if index < len(towns) and delay > 0:
            time.sleep(delay)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--towns", type=Path, default=Path("docs") / "taiwan_towns.json")
    parser.add_argument("--output", type=Path, default=Path("docs") / "cwa_rain_probability.json")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--delay", type=float, default=0.02)
    parser.add_argument("--timeout", type=int, default=12)
    args = parser.parse_args()

    data = generate(args.towns, args.output, args.limit, args.delay, args.timeout)
    print(f"Wrote {len(data['towns'])} CWA town rain probability entries to {args.output}")


if __name__ == "__main__":
    main()

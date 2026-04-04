#!/usr/bin/env python3
"""
fetch_release_dates_igdb.py
----------------------------
Pulls exact release dates from IGDB for all games in games-database.json
and adds a `releaseDate` field (ISO string, e.g. "1999-11-09") to each entry.

Region priority:
  1. North America (region 2)
  2. Worldwide (region 8)
  3. Europe (region 1)
  4. Earliest date from any region (fallback)

Run from your project root:
    python fetch_release_dates_igdb.py

Output: games-database.json is updated in-place (backup saved first).
"""

import json
import time
import requests
from datetime import datetime, timezone
from pathlib import Path

# ── IGDB credentials ──────────────────────────────────────────────────────────
CLIENT_ID = "uijc7itihbez5spq8wj3pvxnidsani"
ACCESS_TOKEN = "ghpt5hwurgfamxwxupei6vo4wc75xx"

IGDB_URL = "https://api.igdb.com/v4/release_dates"
HEADERS = {
    "Client-ID": CLIENT_ID,
    "Authorization": f"Bearer {ACCESS_TOKEN}",
    "Content-Type": "text/plain",
}

# Region codes in priority order
REGION_PRIORITY = [2, 8, 1, 3, 4, 5, 6, 7]  # NA, Worldwide, EU, AU, NZ, JP, CH, KR

BATCH_SIZE = 10      # IGDB allows up to 500 IDs per query but keep it safe
SLEEP_BETWEEN = 0.25  # seconds between requests (rate limit: 4 req/sec)
DB_PATH = "metaguess_database_fixed.json"


def fetch_release_dates_batch(igdb_ids: list[int]) -> dict[int, str]:
    """
    Query IGDB for release dates for a batch of game IDs.
    Returns a dict of {igdb_id: "YYYY-MM-DD"}.
    """
    ids_str = ",".join(str(i) for i in igdb_ids)
    query = f"""
        fields game, date, human, region, platform;
        where game = ({ids_str}) & date != null;
        limit 500;
    """
    # category = 0 means "main game" release (not DLC, update, etc.)

    try:
        resp = requests.post(IGDB_URL, headers=HEADERS, data=query, timeout=15)
        resp.raise_for_status()
        entries = resp.json()
    except Exception as e:
        print(f"  ⚠️  IGDB error for batch {igdb_ids[:3]}...: {e}")
        return {}

    # Group by game_id
    by_game: dict[int, list[dict]] = {}
    for entry in entries:
        gid = entry.get("game")
        if gid:
            by_game.setdefault(gid, []).append(entry)

    result: dict[int, str] = {}
    for gid, releases in by_game.items():
        chosen = pick_best_release(releases)
        if chosen:
            result[gid] = chosen

    return result


def pick_best_release(releases: list[dict]) -> str | None:
    """
    Given a list of release date entries for one game, pick the best canonical date.
    Priority: NA > Worldwide > EU > earliest available.
    Returns an ISO date string "YYYY-MM-DD" or None.
    """
    # Build a map of region → earliest timestamp for that region
    region_dates: dict[int, int] = {}
    for r in releases:
        region = r.get("region")
        ts = r.get("date")
        if region is not None and ts is not None:
            if region not in region_dates or ts < region_dates[region]:
                region_dates[region] = ts

    # Walk through priority order
    for region in REGION_PRIORITY:
        if region in region_dates:
            return ts_to_iso(region_dates[region])

    # Absolute fallback: earliest date from any region
    if releases:
        earliest = min(r["date"] for r in releases if r.get("date") is not None)
        return ts_to_iso(earliest)

    return None


def ts_to_iso(unix_ts: int) -> str:
    """Convert Unix timestamp to ISO date string YYYY-MM-DD."""
    return datetime.fromtimestamp(unix_ts, tz=timezone.utc).strftime("%Y-%m-%d")


def main():
    db_path = Path(DB_PATH)
    if not db_path.exists():
        print(f"❌ Could not find {DB_PATH}. Run from your project root.")
        return

    # Load database
    print(f"📂 Loading {DB_PATH}...")
    with open(db_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, dict) and "games" in raw:
        games = raw["games"]
        wrapper = raw  # keep reference to save back correctly
        print(f"   {len(games)} games loaded (unwrapped metadata object)")
    elif isinstance(raw, list):
        games = raw
        wrapper = None
        print(f"   {len(games)} games loaded.")
    else:
        print("ERROR: Unexpected JSON structure.")
        return

    # Backup
    backup_path = db_path.with_suffix(".backup.json")
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False)
    print(f"💾 Backup saved to {backup_path.name}")

    # Find games that need dates (all, or only missing)
    needs_date = [g for g in games if g.get("igdb_id")]
    already_done = sum(1 for g in games if g.get("releaseDate"))
    print(f"🎯 {len(needs_date)} games have igdb_id | {already_done} already have releaseDate")

    # Build lookup by igdb_id for fast updates
    id_to_game = {g["igdb_id"]: g for g in games}

    # Process in batches
    igdb_ids = [g["igdb_id"] for g in needs_date if not g.get("releaseDate")]
    total = len(igdb_ids)
    print(f"🔍 Fetching dates for {total} games from IGDB...")

    updated = 0
    failed = 0

    for i in range(0, total, BATCH_SIZE):
        batch = igdb_ids[i : i + BATCH_SIZE]
        dates = fetch_release_dates_batch(batch)

        for igdb_id in batch:
            game = id_to_game.get(igdb_id)
            if not game:
                continue
            if igdb_id in dates:
                game["releaseDate"] = dates[igdb_id]
                updated += 1
            else:
                failed += 1

        progress = min(i + BATCH_SIZE, total)
        print(f"   [{progress}/{total}] +{len(dates)} dates this batch", end="\r")
        time.sleep(SLEEP_BETWEEN)

    print(f"\n✅ Done! Updated: {updated} | No date found: {failed}")

    # Save updated database
    with open(db_path, "w", encoding="utf-8") as f:
        if wrapper is not None:
            wrapper["games"] = games
            json.dump(wrapper, f, ensure_ascii=False, indent=2)
        else:
            json.dump(games, f, ensure_ascii=False, indent=2)
    print(f"💾 Saved to {DB_PATH}")

    # Summary stats
    with_date = sum(1 for g in games if g.get("releaseDate"))
    without_date = len(games) - with_date
    print(f"\n📊 Final: {with_date} games have releaseDate | {without_date} still missing")
    if without_date > 0:
        missing = [g["name"] for g in games if not g.get("releaseDate")][:10]
        print(f"   First 10 missing: {missing}")


if __name__ == "__main__":
    main()

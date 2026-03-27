#!/usr/bin/env python3
"""
merge_and_fix.py
----------------
Merges proofed attribute CSV into games JSON using igdb_id as the stable key.
Removes games not present in CSV, applies attribute overrides, and fixes
all app-required fields (id, coverUrl, popularityRank).

This replaces the old index-based merge_attributes.py. Adding new games
to the JSON no longer breaks CSV mappings because we match by igdb_id, not position.

Usage:
    python merge_and_fix.py <games.json> <attributes.csv> [output.json]

If output.json is omitted, writes to games-database.json.

CSV must have an 'igdb_id' column. Use attributes_with_igdbid.csv (migrated from
the old index-based CSV using migrate_csv_to_igdbid.py).
"""

import csv
import json
import sys

ATTR_FIELDS = ["protagonistGender", "protagonistType", "artStyle", "setting"]


def main():
    if len(sys.argv) < 3:
        print("Usage: python merge_and_fix.py <games.json> <attributes.csv> [output.json]")
        sys.exit(1)

    games_path = sys.argv[1]
    csv_path = sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else "games-database.json"

    # --- Load games JSON (handle wrapped or plain array) ---
    with open(games_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, dict) and "games" in raw:
        games = raw["games"]
        print(f"Loaded {len(games)} games from {games_path} (unwrapped metadata object)")
    elif isinstance(raw, list):
        games = raw
        print(f"Loaded {len(games)} games from {games_path}")
    else:
        print(f"ERROR: Unexpected JSON structure in {games_path}")
        sys.exit(1)

    # Build lookup by igdb_id
    games_by_id = {}
    for g in games:
        igdb_id = g.get("igdb_id")
        if igdb_id is None:
            print(f"  WARNING: game '{g.get('name')}' has no igdb_id, skipping")
            continue
        games_by_id[igdb_id] = g

    # --- Load CSV (must have igdb_id column) ---
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    if "igdb_id" not in (rows[0].keys() if rows else []):
        print("ERROR: CSV must have an 'igdb_id' column.")
        print("       Run migrate_csv_to_igdbid.py to convert your old index-based CSV.")
        sys.exit(1)

    print(f"Loaded {len(rows)} rows from {csv_path}")

    # Build CSV lookup by igdb_id
    csv_by_id = {}
    for row in rows:
        try:
            igdb_id = int(row["igdb_id"])
        except (ValueError, TypeError):
            print(f"  WARNING: invalid igdb_id '{row.get('igdb_id')}' in CSV, skipping")
            continue
        csv_by_id[igdb_id] = row

    # --- STEP 1: Filter to games present in CSV, apply attribute overrides ---
    keep_ids = set(csv_by_id.keys())
    all_ids = set(games_by_id.keys())
    removed_ids = all_ids - keep_ids
    new_in_csv = keep_ids - all_ids  # in CSV but not in JSON (stale CSV entries)

    removed_names = [games_by_id[i].get("name", str(i)) for i in removed_ids]

    applied = 0
    warnings = 0
    merged_games = []

    for igdb_id in sorted(keep_ids):
        game = games_by_id.get(igdb_id)
        if game is None:
            print(f"  WARNING: igdb_id {igdb_id} is in CSV but not in JSON, skipping")
            warnings += 1
            continue

        row = csv_by_id[igdb_id]

        # Sanity check name
        csv_name = row.get("name", "").strip()
        json_name = game.get("name", "").strip()
        if csv_name and csv_name != json_name:
            print(f"  WARNING: name mismatch for igdb_id {igdb_id}: "
                  f"CSV='{csv_name}' vs JSON='{json_name}' (applying attributes anyway)")
            warnings += 1

        # Apply CSV attribute fields
        for field in ATTR_FIELDS:
            val = row.get(field, "").strip()
            if val:
                game[field] = val

        merged_games.append(game)
        applied += 1

    print(f"\nStep 1: Kept {applied} games, removed {len(removed_names)}, {warnings} warnings")
    if removed_names:
        print(f"  Removed ({len(removed_names)}):")
        for name in removed_names[:15]:
            print(f"    - {name}")
        if len(removed_names) > 15:
            print(f"    ... and {len(removed_names) - 15} more")
    if new_in_csv:
        print(f"  NOTE: {len(new_in_csv)} igdb_ids in CSV not found in JSON (stale): {sorted(new_in_csv)[:5]}")

    # --- STEP 2: Sort by original popularity ranking ---
    # Preserve the order from the source JSON (already sorted by rank)
    # Games are appended in sorted(keep_ids) order above — re-sort by original rank
    merged_games.sort(key=lambda g: g.get("igdb_original_rank", 9999))

    # --- STEP 3: Fix app-required fields ---
    fixed_id = 0
    fixed_cover = 0
    fixed_rank = 0

    for i, game in enumerate(merged_games):
        # id from igdb_id
        igdb_id = game.get("igdb_id")
        if igdb_id is not None and game.get("id") != igdb_id:
            game["id"] = igdb_id
            fixed_id += 1

        # coverUrl from cover_image (strip https:)
        cover = game.get("cover_image", "")
        expected = cover.replace("https:", "") if cover else ""
        if game.get("coverUrl") != expected:
            game["coverUrl"] = expected
            fixed_cover += 1

        # popularityRank = 1..N (positional, used by app)
        new_rank = i + 1
        if game.get("popularityRank") != new_rank:
            fixed_rank += 1
        game["popularityRank"] = new_rank
        game["rank"] = new_rank

    print(f"Step 2: Sorted by igdb_original_rank")
    print(f"Step 3: Fixed {fixed_id} ids, {fixed_cover} coverUrls, {fixed_rank} ranks")

    # --- SAVE as plain array ---
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(merged_games, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Saved {len(merged_games)} games to {out_path}")


if __name__ == "__main__":
    main()

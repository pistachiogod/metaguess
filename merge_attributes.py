#!/usr/bin/env python3
"""
merge_and_fix.py
----------------
Merges proofed attribute CSV into games JSON, removes deleted games,
and fixes all app-required fields (id, coverUrl, popularityRank).

Handles both plain JSON arrays AND metadata-wrapped JSON (with a "games" key).

Usage:
    python merge_and_fix.py <games.json> <attributes.csv> [output.json]

If output.json is omitted, writes to games-database.json.
"""

import csv
import json
import sys
import os

ATTR_FIELDS = ["protagonistGender", "protagonistType", "artStyle", "setting"]


def main():
    if len(sys.argv) < 3:
        print("Usage: python merge_and_fix.py <games.json> <attributes.csv> [output.json]")
        sys.exit(1)

    games_path = sys.argv[1]
    csv_path = sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else "games-database.json"

    # Load games — handle both wrapped {"games": [...]} and plain [...]
    with open(games_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, dict) and "games" in raw:
        games = raw["games"]
        print(f"Loaded {len(games)} games from {games_path} (unwrapped from metadata object)")
    elif isinstance(raw, list):
        games = raw
        print(f"Loaded {len(games)} games from {games_path}")
    else:
        print(f"ERROR: Unexpected JSON structure in {games_path}")
        sys.exit(1)

    # Load CSV
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    print(f"Loaded {len(rows)} rows from {csv_path}")

    # Build lookup by index
    attr_map = {}
    for row in rows:
        idx = int(row["index"])
        attr_map[idx] = row

    # Figure out which games to keep vs remove
    keep_indices = set(attr_map.keys())
    remove_indices = set(range(len(games))) - keep_indices
    removed_names = [games[i].get("name", f"index {i}") for i in sorted(remove_indices)]

    # --- STEP 1: Remove deleted games + merge attributes ---
    applied = 0
    warnings = 0
    merged_games = []

    for idx in sorted(keep_indices):
        if idx < 0 or idx >= len(games):
            print(f"  WARNING: index {idx} out of range (0-{len(games)-1}), skipping")
            warnings += 1
            continue

        game = games[idx]
        row = attr_map[idx]
        csv_name = row["name"].strip()
        json_name = game.get("name", "").strip()

        if csv_name != json_name:
            print(f"  WARNING: name mismatch at index {idx}: CSV='{csv_name}' vs JSON='{json_name}' (applying anyway)")
            warnings += 1

        for field in ATTR_FIELDS:
            val = row.get(field, "").strip()
            if val:
                game[field] = val

        merged_games.append(game)
        applied += 1

    print(f"\nStep 1: Kept {applied}, removed {len(removed_names)} ({warnings} warnings)")
    if removed_names:
        print(f"  Removed ({len(removed_names)}):")
        for name in removed_names[:15]:
            print(f"    - {name}")
        if len(removed_names) > 15:
            print(f"    ... and {len(removed_names) - 15} more")

    # --- STEP 2: Fix app-required fields ---
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

        # popularityRank = 1..N
        new_rank = i + 1
        if game.get("popularityRank") != new_rank:
            fixed_rank += 1
        game["popularityRank"] = new_rank
        game["rank"] = new_rank

    print(f"Step 2: Fixed {fixed_id} ids, {fixed_cover} coverUrls, {fixed_rank} ranks")

    # --- SAVE as plain array (what the app expects) ---
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(merged_games, f, indent=2, ensure_ascii=False)
    print(f"\nSaved {len(merged_games)} games to {out_path}")


if __name__ == "__main__":
    main()
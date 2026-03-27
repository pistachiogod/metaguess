#!/usr/bin/env python3
"""
add_new_games.py
----------------
Fetches new games from IGDB + RAWG and adds them to metaguess_database_fixed.json.
Never touches games already in the database (matched by igdb_id).
After running, prints a ready-to-fill CSV snippet for attributes_with_igdbid.csv.

Usage:
    # Add specific games by IGDB ID (most reliable — look up ID on igdb.com)
    python add_new_games.py --ids 123 456 789

    # Search by name — shows top results so YOU pick the right one
    python add_new_games.py --names "Hollow Knight" "Marathon"

    # Find N recently released games not already in your database
    python add_new_games.py --recent 20
    python add_new_games.py --recent 20 --since 2022   # only since 2022

Requirements:
    pip install requests

IGDB credentials (already yours):
    client_id: uijc7itihbez5spq8wj3pvxnidsani
    token:      lcnxsfe58yfx049xveirl7lj44fne7
"""

import argparse
import csv
import io
import json
import re
import sys
import time
from difflib import SequenceMatcher
from typing import Dict, List, Optional, Tuple

# ==================== CONFIGURATION ====================

def _load_env():
    """Load .env file if present (no external dependencies needed)."""
    import os
    from pathlib import Path
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, _, val = line.partition('=')
                    os.environ.setdefault(key.strip(), val.strip())

_load_env()

import os as _os

IGDB_CLIENT_ID    = _os.environ.get('IGDB_CLIENT_ID', '')
IGDB_ACCESS_TOKEN = _os.environ.get('IGDB_ACCESS_TOKEN', '')
RAWG_API_KEY      = _os.environ.get('RAWG_API_KEY', '')

if not IGDB_CLIENT_ID or not IGDB_ACCESS_TOKEN:
    print("❌ Missing IGDB credentials. Add them to your .env file:")
    print("   IGDB_CLIENT_ID=...")
    print("   IGDB_ACCESS_TOKEN=...")
    raise SystemExit(1)
if not RAWG_API_KEY:
    print("⚠️  RAWG_API_KEY not set — RAWG enrichment will be skipped")

DATABASE_FILE     = 'metaguess_database_fixed.json'   # your curated source
ATTRIBUTES_CSV    = 'attributes_with_igdbid.csv'       # your manual fields CSV

IGDB_URL = "https://api.igdb.com/v4/games"
RAWG_URL = "https://api.rawg.io/api/games"

IGDB_HEADERS = {
    'Client-ID': IGDB_CLIENT_ID,
    'Authorization': f'Bearer {IGDB_ACCESS_TOKEN}',
    'Accept': 'application/json',
}

# Fields we pull from IGDB — single line, no newlines (IGDB is sensitive to formatting)
IGDB_FIELDS = (
    "id,name,first_release_date,"
    "rating,rating_count,total_rating,total_rating_count,"
    "aggregated_rating,aggregated_rating_count,"
    "follows,hypes,"
    "cover.url,cover.image_id,"
    "genres.name,themes.name,game_modes.name,"
    "player_perspectives.name,"
    "involved_companies.company.name,involved_companies.publisher,"
    "franchises.name,"
    "platforms.name,platforms.platform_family.name,"
    "summary,category"
)

# How many games per IGDB batch request (max 500)
IGDB_BATCH_SIZE = 500

# RAWG fuzzy match thresholds
EXACT_THRESH = 0.95
FUZZY_THRESH = 0.70


# ==================== IGDB HELPERS ====================

def igdb_post(body: str, retries: int = 3) -> List[Dict]:
    """POST to IGDB with retry."""
    import requests
    for attempt in range(retries):
        try:
            r = requests.post(IGDB_URL, headers=IGDB_HEADERS, data=body, timeout=30)
            if r.status_code == 401:
                print("  ❌ IGDB 401 — token expired. Get a new one at dev.twitch.tv/console")
                sys.exit(1)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == retries - 1:
                print(f"  ❌ IGDB error after {retries} attempts: {e}")
                return []
            time.sleep(2 ** attempt)
    return []


def fetch_by_ids(igdb_ids: List[int]) -> List[Dict]:
    """Fetch full game data for a list of IGDB IDs."""
    results = []
    for i in range(0, len(igdb_ids), IGDB_BATCH_SIZE):
        batch = igdb_ids[i:i + IGDB_BATCH_SIZE]
        id_list = ','.join(str(x) for x in batch)
        body = f"fields {IGDB_FIELDS}; where id = ({id_list}); limit {IGDB_BATCH_SIZE};"
        data = igdb_post(body)
        results.extend(data)
        print(f"  Fetched {len(results)}/{len(igdb_ids)} games from IGDB...")
        if i + IGDB_BATCH_SIZE < len(igdb_ids):
            time.sleep(0.5)
    return results


def fetch_by_names(names: List[str]) -> List[Dict]:
    """
    Search IGDB for each game name. Shows top 5 candidates and asks you to
    pick the right one — prevents grabbing the wrong game (e.g. 1994 Marathon
    instead of the new Bungie one).
    """
    results = []
    for name in names:
        body = f'search "{name}"; fields {IGDB_FIELDS}; limit 8;'
        data = igdb_post(body)

        if not data:
            print(f"  ⚠ No IGDB results for: {name}")
            continue

        # Show candidates
        print(f"\n  Search results for \"{name}\":")
        for i, g in enumerate(data):
            ts = g.get('first_release_date')
            year = ''
            if ts:
                from datetime import datetime, timezone
                year = datetime.fromtimestamp(ts, tz=timezone.utc).year
            platforms = [p['name'] for p in g.get('platforms', [])]
            plat_str = ', '.join(platforms[:3]) + ('...' if len(platforms) > 3 else '')
            print(f"    [{i}] {g.get('name')} ({year}) — id={g.get('id')}  [{plat_str}]")

        # Let user pick
        while True:
            choice = input(f"  Pick number (0-{len(data)-1}), or s to skip: ").strip().lower()
            if choice == 's':
                print(f"  Skipping {name}")
                break
            try:
                idx = int(choice)
                if 0 <= idx < len(data):
                    chosen = data[idx]
                    print(f"  ✓ Selected: {chosen.get('name')} (id={chosen.get('id')})")
                    results.append(chosen)
                    break
                else:
                    print(f"  Enter a number between 0 and {len(data)-1}")
            except ValueError:
                print(f"  Enter a number or 's' to skip")

        time.sleep(0.3)
    return results


def fetch_recent_igdb(n: int, existing_ids: set, min_year: int = 2020) -> List[Dict]:
    """
    Fetch the N most recently released games from IGDB that aren't already
    in your database, sorted by release date descending.
    """
    from datetime import datetime, timezone

    cutoff_ts = int(datetime(min_year, 1, 1, tzinfo=timezone.utc).timestamp())
    print(f"  Searching IGDB for up to {n} recent games (since {min_year}) not in database...")

    # Inline fields string — no newlines, IGDB is sensitive to formatting
    fields = (
        "id,name,first_release_date,rating,rating_count,follows,"
        "cover.url,genres.name,themes.name,game_modes.name,"
        "player_perspectives.name,involved_companies.company.name,"
        "involved_companies.publisher,franchises.name,"
        "platforms.name,summary,category"
    )

    results = []
    offset = 0
    batch = 50
    scanned = 0

    while len(results) < n:
        query = (
            f"fields {fields}; "
            f"sort first_release_date desc; "
            f"where first_release_date > {cutoff_ts} "
            f"& cover != null "
            f"& rating_count > 5 "
            f"& category = 0; "
            f"limit {batch}; "
            f"offset {offset};"
        )

        print(f"  Querying IGDB (offset={offset})...", end='', flush=True)
        data = igdb_post(query)

        if not data:
            # Try without category filter in case it's the issue
            if offset == 0:
                print(f" 0 results — retrying without category filter...")
                query_no_cat = (
                    f"fields {fields}; "
                    f"sort first_release_date desc; "
                    f"where first_release_date > {cutoff_ts} "
                    f"& cover != null "
                    f"& rating_count > 5; "
                    f"limit {batch}; "
                    f"offset {offset};"
                )
                data = igdb_post(query_no_cat)
                if not data:
                    print(f" still 0 — stopping")
                    break
                print(f" got {len(data)} results (no category filter)")
            else:
                print(f" 0 results — stopping")
                break

        scanned += len(data)

        # Show sample
        if offset == 0 and data:
            s = data[0]
            ts = s.get('first_release_date', 0)
            yr = datetime.fromtimestamp(ts, tz=timezone.utc).year if ts else '?'
            print(f"  Sample: {s.get('name')} ({yr}) id={s.get('id')} category={s.get('category')}")

        new = [g for g in data if g.get('id') not in existing_ids]
        results.extend(new)
        print(f"  {len(new)} new this batch, {len(results)} total (scanned {scanned})")

        if len(data) < batch:
            break
        offset += batch
        time.sleep(0.4)

    results.sort(key=lambda g: g.get('rating_count', 0), reverse=True)
    return results[:n]


# ==================== RAWG MATCHING ====================

def normalize(name: str) -> str:
    if not name:
        return ''
    n = name.lower().strip()
    for prefix in ['the ', 'a ']:
        if n.startswith(prefix):
            n = n[len(prefix):]
    n = re.sub(r'[^a-z0-9\s]', ' ', n)
    n = re.sub(r'\s+', ' ', n).strip()
    return n


def fuzzy_match(target: str, candidates: List[Dict]) -> Tuple[Optional[Dict], float]:
    norm_target = normalize(target)
    best, best_score = None, 0.0
    for c in candidates:
        score = SequenceMatcher(None, norm_target, normalize(c.get('name', ''))).ratio()
        if score > best_score:
            best_score = score
            best = c
    if best_score >= FUZZY_THRESH:
        return best, best_score
    return None, best_score


def fetch_rawg_match(game_name: str) -> Optional[Dict]:
    """Search RAWG for a game by name, return matched data or None."""
    import requests
    params = {
        'key': RAWG_API_KEY,
        'search': game_name,
        'page_size': 5,
        'search_precise': 'true',
    }
    try:
        r = requests.get(RAWG_URL, params=params, timeout=15)
        r.raise_for_status()
        results = r.json().get('results', [])
        if not results:
            return None
        match, score = fuzzy_match(game_name, results)
        if match:
            return {
                'rawg_ratings_count': match.get('ratings_count', 0),
                'rawg_added':         match.get('added', 0),
                'rawg_rating':        match.get('rating', 0),
                'metacritic':         match.get('metacritic'),
                'rawg_matched':       True,
                'rawg_match_score':   round(score, 3),
            }
    except Exception as e:
        print(f"    RAWG error for '{game_name}': {e}")
    return None


# ==================== IGDB DATA → DB RECORD ====================

def igdb_to_record(g: Dict) -> Dict:
    """Convert raw IGDB API response into the metaguess DB format."""

    # Release year
    ts = g.get('first_release_date')
    year = None
    if ts:
        from datetime import datetime, timezone
        year = datetime.fromtimestamp(ts, tz=timezone.utc).year

    # Cover image
    cover = g.get('cover', {})
    cover_url = ''
    if cover and cover.get('url'):
        cover_url = 'https:' + cover['url'].replace('t_thumb', 't_cover_big')

    # Genres
    genres = [x['name'] for x in g.get('genres', [])]
    primary_genre = genres[0] if genres else None

    # Themes
    themes = [x['name'] for x in g.get('themes', [])]
    primary_theme = themes[0] if themes else None

    # Game modes
    game_modes = [x['name'] for x in g.get('game_modes', [])]
    is_multiplayer = any('Multiplayer' in m or 'Co-operative' in m for m in game_modes)

    # Perspective
    perspectives = [x['name'] for x in g.get('player_perspectives', [])]
    perspective = perspectives[0] if perspectives else None

    # Publisher
    publisher = None
    for company in g.get('involved_companies', []):
        if company.get('publisher'):
            publisher = company.get('company', {}).get('name')
            break

    # Franchise
    franchises = g.get('franchises', [])
    franchise = franchises[0]['name'] if franchises else None

    # Platforms
    all_platforms = [p['name'] for p in g.get('platforms', [])]

    # Platform family logic (simplified — same logic as fix_platforms_igdb.py)
    FAMILIES = {
        'PlayStation': ['PlayStation', 'PS Vita', 'PSP'],
        'Xbox':        ['Xbox'],
        'Nintendo':    ['Nintendo', 'Game Boy', 'Wii', 'Switch', 'DS', '3DS', 'NES', 'SNES', 'N64'],
        'Sega':        ['Sega', 'Dreamcast', 'Saturn', 'Genesis', 'Mega Drive'],
        'PC':          ['PC', 'Windows', 'Linux', 'Mac'],
    }

    def get_family(plat_name):
        for fam, keywords in FAMILIES.items():
            if any(kw.lower() in plat_name.lower() for kw in keywords):
                return fam
        return 'Other'

    families = set(get_family(p) for p in all_platforms)
    platform = 'Multi-platform' if len(families) > 1 else (all_platforms[0] if all_platforms else 'Unknown')

    igdb_id = g.get('id')

    return {
        'igdb_id':              igdb_id,
        'name':                 g.get('name'),
        'year':                 year,
        'igdb_rating_count':    g.get('rating_count', 0),
        'rawg_ratings_count':   0,          # filled in by RAWG match
        'combined_rating_count':g.get('rating_count', 0),
        'igdb_rating':          round(g.get('rating', 0), 1) if g.get('rating') else None,
        'igdb_popularity':      g.get('follows', 0),
        'igdb_original_rank':   None,       # filled in after sort
        'igdb_follows':         g.get('follows', 0),
        'rawg_added':           0,
        'metacritic':           None,
        'rawg_matched':         False,
        'primaryGenre':         primary_genre,
        'genres':               genres,
        'platform':             platform,
        'allPlatforms':         all_platforms,
        'perspective':          perspective,
        'themes':               themes,
        'primaryTheme':         primary_theme,
        'gameModes':            game_modes,
        'isMultiplayer':        is_multiplayer,
        'publisher':            publisher,
        'franchise':            franchise,
        'description':          g.get('summary', ''),
        'cover_image':          cover_url,
        # Manual fields — left blank for CSV
        'protagonistGender':    '',
        'protagonistType':      '',
        'artStyle':             '',
        'setting':              '',
        # App-required fields — set by merge_and_fix.py
        'id':                   igdb_id,
        'coverUrl':             cover_url.replace('https:', '') if cover_url else '',
        'popularityRank':       None,
        'rank':                 None,
    }


# ==================== MAIN ====================

def main():
    import requests  # import here so the error is clear if missing

    parser = argparse.ArgumentParser(description='Add new games to metaguess_database_fixed.json')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--ids',   nargs='+', type=int, metavar='ID',
                       help='IGDB game IDs to add')
    group.add_argument('--names', nargs='+', metavar='NAME',
                       help='Game names to search for on IGDB')
    group.add_argument('--recent', type=int, metavar='N',
                       help='Find N recently released games (since 2020) not already in database')

    parser.add_argument('--database', default=DATABASE_FILE,
                        help=f'Path to database file (default: {DATABASE_FILE})')
    parser.add_argument('--csv', default=ATTRIBUTES_CSV,
                        help=f'Path to attributes CSV (default: {ATTRIBUTES_CSV})')
    parser.add_argument('--since', type=int, default=2020, metavar='YEAR',
                        help='For --recent: only include games released since this year (default: 2020)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Preview what would be added without writing files')

    args = parser.parse_args()

    print("=" * 70)
    print("METAGUESS — ADD NEW GAMES")
    print("=" * 70)

    # --- Load existing database ---
    print(f"\nLoading database: {args.database}")
    try:
        with open(args.database, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except FileNotFoundError:
        print(f"  ❌ File not found: {args.database}")
        sys.exit(1)

    if isinstance(raw, dict) and 'games' in raw:
        existing = raw['games']
    elif isinstance(raw, list):
        existing = raw
    else:
        print("  ❌ Unrecognized JSON format")
        sys.exit(1)

    existing_ids = {g.get('igdb_id') for g in existing if g.get('igdb_id')}
    print(f"  {len(existing)} games loaded, {len(existing_ids)} unique IGDB IDs")

    # --- Load existing CSV to check for igdb_id duplicates ---
    csv_ids = set()
    try:
        with open(args.csv, 'r', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                try:
                    csv_ids.add(int(row['igdb_id']))
                except (ValueError, KeyError):
                    pass
        print(f"  {len(csv_ids)} games in attributes CSV")
    except FileNotFoundError:
        print(f"  ⚠ CSV not found at {args.csv} — will still show CSV snippet")

    # --- Fetch from IGDB ---
    print(f"\nFetching from IGDB...")
    if args.ids:
        igdb_raw = fetch_by_ids(args.ids)
    elif args.names:
        igdb_raw = fetch_by_names(args.names)
    else:  # --recent
        igdb_raw = fetch_recent_igdb(args.recent, existing_ids, min_year=args.since)

    if not igdb_raw:
        print("  ❌ No games returned from IGDB")
        sys.exit(1)

    # --- Filter out already-existing games ---
    candidates = [g for g in igdb_raw if g.get('id') not in existing_ids]
    already_have = [g for g in igdb_raw if g.get('id') in existing_ids]

    if already_have:
        print(f"\n  ⏭  Already in database ({len(already_have)}), skipping:")
        for g in already_have:
            print(f"      - {g.get('name')} (id={g.get('id')})")

    if not candidates:
        print("\n  ✅ Nothing new to add — all games already in database")
        sys.exit(0)

    # --- Interactive review: approve each candidate ---
    # --names already did interactive picking, so only review for --ids and --recent
    if args.recent:
        print(f"\n  Found {len(candidates)} new games. Review each one:\n")
        truly_new = []
        for g in candidates:
            ts = g.get('first_release_date')
            year = ''
            if ts:
                from datetime import datetime, timezone
                year = datetime.fromtimestamp(ts, tz=timezone.utc).year
            platforms = [p['name'] for p in g.get('platforms', [])]
            plat_str = ', '.join(platforms[:3]) + ('...' if len(platforms) > 3 else '')
            genres = [x['name'] for x in g.get('genres', [])]
            genre_str = ', '.join(genres[:2])
            print(f"  {g.get('name')} ({year}) — id={g.get('id')}")
            print(f"    Platforms: {plat_str}")
            print(f"    Genre: {genre_str}  |  Rating count: {g.get('rating_count', 0):,}")
            choice = input(f"  Add this game? (y/n/q to quit): ").strip().lower()
            if choice == 'q':
                print("  Stopped early.")
                break
            elif choice == 'y':
                truly_new.append(g)
                print(f"  ✓ Added\n")
            else:
                print(f"  Skipped\n")
    else:
        # --ids and --names already handled selection upstream
        truly_new = candidates

    if not truly_new:
        print("\n  No games selected. Nothing to add.")
        sys.exit(0)

    print(f"\n  {len(truly_new)} games to add:")
    for g in truly_new:
        print(f"    + {g.get('name')} (id={g.get('id')})")

    # --- Convert to DB records ---
    new_records = [igdb_to_record(g) for g in truly_new]

    # --- Enrich with RAWG ---
    print(f"\nMatching against RAWG...")
    for rec in new_records:
        name = rec['name']
        print(f"  Searching RAWG: {name}...", end='', flush=True)
        rawg = fetch_rawg_match(name)
        if rawg:
            rec.update(rawg)
            rec['combined_rating_count'] = (
                rec.get('igdb_rating_count', 0) + rec.get('rawg_ratings_count', 0)
            )
            print(f" ✓ (metacritic={rawg.get('metacritic')}, added={rawg.get('rawg_added'):,})")
        else:
            print(f" ⚠ no RAWG match")
        time.sleep(0.3)

    # --- Assign igdb_original_rank (new games get a rank after existing ones) ---
    # Existing games keep their ranks; new ones are appended sorted by follows desc
    new_records.sort(key=lambda g: g.get('igdb_follows', 0), reverse=True)
    max_existing_rank = max((g.get('igdb_original_rank') or 0 for g in existing), default=0)
    for i, rec in enumerate(new_records):
        rec['igdb_original_rank'] = max_existing_rank + i + 1

    # --- Merge into database ---
    if isinstance(raw, dict) and 'games' in raw:
        raw['games'] = existing + new_records
        output = raw
    else:
        output = existing + new_records

    if args.dry_run:
        print(f"\n[DRY RUN] Would add {len(new_records)} games to {args.database}")
        print(f"[DRY RUN] No files written")
    else:
        with open(args.database, 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
        print(f"\n✅ Saved {len(new_records)} new games to {args.database}")

    # --- Print CSV snippet for attributes_with_igdbid.csv ---
    print("\n" + "=" * 70)
    print("ADD THESE ROWS TO attributes_with_igdbid.csv")
    print("Fill in the 4 blank fields, then run merge_and_fix.py")
    print("=" * 70)

    buf = io.StringIO()
    fields = ['igdb_id', 'name', 'year', 'protagonistGender', 'protagonistType', 'artStyle', 'setting']
    writer = csv.DictWriter(buf, fieldnames=fields, extrasaction='ignore')

    # Only print header if user needs to create the CSV from scratch
    if not csv_ids:
        writer.writeheader()

    for rec in new_records:
        writer.writerow({
            'igdb_id':          rec['igdb_id'],
            'name':             rec['name'],
            'year':             rec.get('year', ''),
            'protagonistGender':'',
            'protagonistType':  '',
            'artStyle':         '',
            'setting':          '',
        })

    print(buf.getvalue())

    # Also save as a file so you can open it in Excel and fill it in
    snippet_path = 'new_games_to_classify.csv'
    if not args.dry_run:
        with open(snippet_path, 'w', newline='', encoding='utf-8') as f:
            writer2 = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
            writer2.writeheader()
            for rec in new_records:
                writer2.writerow({
                    'igdb_id':          rec['igdb_id'],
                    'name':             rec['name'],
                    'year':             rec.get('year', ''),
                    'protagonistGender':'',
                    'protagonistType':  '',
                    'artStyle':         '',
                    'setting':          '',
                })
        print(f"Saved to {snippet_path} — open in Excel, fill in the 4 fields,")
        print(f"then copy/paste the rows into attributes_with_igdbid.csv")

    print("=" * 70)
    print("\nNEXT STEPS:")
    print(f"  1. Fill in new_games_to_classify.csv (the 4 manual fields)")
    print(f"  2. Append those rows to attributes_with_igdbid.csv")
    print(f"  3. python merge_and_fix.py {args.database} attributes_with_igdbid.csv")
    print(f"  4. Copy games-database.json to src/ and deploy")


if __name__ == '__main__':
    main()

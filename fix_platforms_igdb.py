import json
import requests
import time
import csv
from collections import Counter

def _load_env():
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

HEADERS = {
    'Client-ID': IGDB_CLIENT_ID,
    'Authorization': f'Bearer {IGDB_ACCESS_TOKEN}',
}

# Specific console name for display
PLATFORM_NAME = {
    7: 'PlayStation',
    8: 'PlayStation 2',
    9: 'PlayStation 3',
    48: 'PlayStation 4',
    167: 'PlayStation 5',
    38: 'PSP',
    46: 'PS Vita',

    18: 'NES',
    19: 'SNES',
    4: 'Nintendo 64',
    21: 'GameCube',
    5: 'Wii',
    41: 'Wii U',
    130: 'Nintendo Switch',
    441: 'Nintendo Switch 2',
    33: 'Game Boy',
    22: 'Game Boy Color',
    24: 'Game Boy Advance',
    20: 'Nintendo DS',
    37: 'Nintendo 3DS',
    159: 'Nintendo DS',
    137: 'Nintendo 3DS',

    11: 'Xbox',
    12: 'Xbox 360',
    49: 'Xbox One',
    169: 'Xbox Series X|S',

    6: 'PC',
    13: 'PC',
    14: 'PC',
    3: 'PC',

    29: 'Genesis',
    35: 'Game Gear',
    30: 'Sega 32X',
    78: 'Sega CD',
    32: 'Sega Saturn',
    23: 'Dreamcast',

    52: 'Arcade',
}

# Family grouping (only for the 3-month multi-platform check)
PLATFORM_FAMILY = {
    7: 'PlayStation', 8: 'PlayStation', 9: 'PlayStation', 48: 'PlayStation', 167: 'PlayStation', 38: 'PlayStation', 46: 'PlayStation',
    18: 'Nintendo', 19: 'Nintendo', 4: 'Nintendo', 21: 'Nintendo', 5: 'Nintendo', 41: 'Nintendo', 130: 'Nintendo', 441: 'Nintendo',
    33: 'Nintendo', 22: 'Nintendo', 24: 'Nintendo', 20: 'Nintendo', 37: 'Nintendo', 159: 'Nintendo', 137: 'Nintendo',
    11: 'Xbox', 12: 'Xbox', 49: 'Xbox', 169: 'Xbox',
    6: 'PC', 13: 'PC', 14: 'PC', 3: 'PC',
    29: 'Sega', 35: 'Sega', 30: 'Sega', 78: 'Sega', 32: 'Sega', 23: 'Sega',
    52: 'Arcade',
}

# Platforms to skip (mobile, VR, streaming, etc.)
SKIP_PLATFORMS = {34, 39, 55, 74, 82, 170, 203, 386, 384, 163, 471, 387, 161, 388, 132, 389, 160, 236, 158, 378, 477}


def query_igdb(endpoint, body, retries=3):
    url = f'https://api.igdb.com/v4/{endpoint}'
    for attempt in range(retries):
        try:
            resp = requests.post(url, headers=HEADERS, data=body, timeout=15)
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 429:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited, waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  API error {resp.status_code}: {resp.text[:200]}")
                time.sleep(1)
        except Exception as e:
            print(f"  Request error: {e}")
            time.sleep(2)
    return None


def get_release_dates_batch(igdb_ids):
    ids_str = ','.join(str(i) for i in igdb_ids)
    body = f'fields game, platform, date, human; where game = ({ids_str}) & date != null & platform != null; limit 500; sort date asc;'
    return query_igdb('release_dates', body)


def determine_platform(releases):
    """Given release dates for one game, determine original platform.
    If multiple platform families release within 3 months -> Multi-platform.
    Otherwise -> specific console name of the earliest release."""

    if not releases:
        return None

    valid = [r for r in releases if r.get('platform') not in SKIP_PLATFORMS and r.get('platform') in PLATFORM_NAME]
    if not valid:
        return None

    valid.sort(key=lambda r: r.get('date', float('inf')))

    earliest_date = valid[0].get('date')
    if not earliest_date:
        return None

    three_months = 90 * 24 * 60 * 60

    early_families = set()
    earliest_platform_id = valid[0].get('platform')

    for r in valid:
        release_date = r.get('date', 0)
        platform_id = r.get('platform')

        if release_date - earliest_date > three_months:
            break

        family = PLATFORM_FAMILY.get(platform_id)
        if family:
            early_families.add(family)

    if len(early_families) == 0:
        return None
    elif len(early_families) == 1:
        return PLATFORM_NAME.get(earliest_platform_id, 'Other')
    else:
        return 'Multi-platform'


def main():
    with open('metaguess_database.json') as f:
        data = json.load(f)
    games = data['games']

    print(f"Total games: {len(games)}")

    id_to_indices = {}
    for i, g in enumerate(games):
        igdb_id = g.get('igdb_id')
        if igdb_id:
            if igdb_id not in id_to_indices:
                id_to_indices[igdb_id] = []
            id_to_indices[igdb_id].append(i)

    all_igdb_ids = list(id_to_indices.keys())
    print(f"Games with IGDB IDs: {len(all_igdb_ids)}")

    BATCH_SIZE = 25
    all_releases = {}

    for batch_start in range(0, len(all_igdb_ids), BATCH_SIZE):
        batch_ids = all_igdb_ids[batch_start:batch_start + BATCH_SIZE]
        batch_num = batch_start // BATCH_SIZE + 1
        total_batches = (len(all_igdb_ids) + BATCH_SIZE - 1) // BATCH_SIZE

        print(f"Batch {batch_num}/{total_batches} ({batch_start}/{len(all_igdb_ids)})...", end=' ')

        results = get_release_dates_batch(batch_ids)

        if results:
            for r in results:
                game_id = r.get('game')
                if game_id not in all_releases:
                    all_releases[game_id] = []
                all_releases[game_id].append(r)
            print(f"got {len(results)} release records")
        else:
            print("no results")

        time.sleep(0.3)

    print(f"\nGot release data for {len(all_releases)} games")

    changes = 0
    no_data = 0
    kept_same = 0
    change_log = []

    for igdb_id, indices in id_to_indices.items():
        releases = all_releases.get(igdb_id, [])
        new_platform = determine_platform(releases)

        for idx in indices:
            game = games[idx]
            old_platform = game.get('platform', '')

            if new_platform is None:
                no_data += 1
                continue

            if new_platform != old_platform:
                valid = sorted(
                    [r for r in releases if r.get('platform') not in SKIP_PLATFORMS and r.get('platform') in PLATFORM_NAME],
                    key=lambda r: r.get('date', float('inf'))
                )
                earliest_human = valid[0].get('human', 'unknown') if valid else 'unknown'

                change_log.append({
                    'name': game['name'],
                    'year': game.get('year', '?'),
                    'old': old_platform,
                    'new': new_platform,
                    'earliest_release': earliest_human,
                })
                game['platform'] = new_platform
                changes += 1
            else:
                kept_same += 1

    print(f"\n=== RESULTS ===")
    print(f"Changed: {changes}")
    print(f"Kept same: {kept_same}")
    print(f"No release data: {no_data}")

    change_types = Counter(f"{c['old']} -> {c['new']}" for c in change_log)
    print(f"\nChange breakdown:")
    for ct, count in change_types.most_common():
        print(f"  {ct}: {count}")

    print(f"\nSample changes:")
    for c in sorted(change_log, key=lambda x: x['name'])[:40]:
        print(f"  {c['name']} ({c['year']}): {c['old']} -> {c['new']} (first: {c['earliest_release']})")

    dist = Counter(g.get('platform', '') for g in games)
    print(f"\nNew platform distribution:")
    for p, count in dist.most_common():
        print(f"  {p}: {count}")

    data['games'] = games
    with open('metaguess_database_fixed.json', 'w') as f:
        json.dump(data, f, indent=2)
    print(f"\nSaved to metaguess_database_fixed.json")

    with open('platform_changes.csv', 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['name', 'year', 'old_platform', 'new_platform', 'earliest_release'])
        for c in sorted(change_log, key=lambda x: x['name']):
            writer.writerow([c['name'], c['year'], c['old'], c['new'], c['earliest_release']])
    print(f"Change log saved to platform_changes.csv ({len(change_log)} changes)")


if __name__ == '__main__':
    main()
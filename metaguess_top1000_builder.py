#!/usr/bin/env python3
"""
Metaguess Top 1000 Builder v2
IGDB database + RAWG data → deduplicate → rank by combined ratings → CSV for review

Pipeline:
  1. Load IGDB games-database.json (1500 games)
  2. Deduplicate editions (Complete Edition, GOTY, Remastered, etc.)
  3. Batch-fetch rating_count from IGDB API
  4. Fuzzy match against RAWG data for rawg_ratings_count
  5. Rank by combined count → output CSV for review

After review:
  python metaguess_finalize.py → metaguess_games.json

Usage:
  python metaguess_top1000_builder.py
  python metaguess_top1000_builder.py --igdb-file games-database.json --rawg-file rawg_top1000_robust.json
  python metaguess_top1000_builder.py --skip-igdb-fetch
"""

import requests
import json
import csv
import time
import re
import sys
import os
from difflib import SequenceMatcher
from datetime import datetime
from typing import Dict, List, Optional, Tuple

# ==================== CONFIGURATION ====================

IGDB_CLIENT_ID = 'uijc7itihbez5spq8wj3pvxnidsani'
IGDB_ACCESS_TOKEN = 'lcnxsfe58yfx049xveirl7lj44fne7'
IGDB_ENABLED = True

IGDB_DATABASE_FILE = 'games-database.json'
RAWG_DATA_FILE = 'rawg_top1000_robust.json'

RANKING_CSV = 'ranking_review.csv'
MATCH_LOG_FILE = 'rawg_match_log.json'

EXACT_MATCH_THRESHOLD = 0.95
FUZZY_MATCH_THRESHOLD = 0.70

# ==================== NAME MATCHING ====================

ROMAN_MAP = {
    'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5',
    'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10',
    'xi': '11', 'xii': '12', 'xiii': '13', 'xiv': '14', 'xv': '15',
    'xvi': '16', 'xvii': '17', 'xviii': '18', 'xix': '19', 'xx': '20',
}

EDITION_KEYWORDS = [
    'definitive edition', 'ultimate edition', 'complete edition',
    'game of the year', 'goty', 'enhanced edition', 'remastered',
    'deluxe edition', 'special edition', 'legendary edition',
    'premium edition', 'gold edition', "director's cut", 'directors cut',
    'anniversary edition', 'hd edition', 'hd', 'extended edition',
    'final cut',
]

def normalize_name(name: str) -> str:
    if not name:
        return ''
    n = name.lower().strip()
    for prefix in ['the ', 'a ']:
        if n.startswith(prefix):
            n = n[len(prefix):]
    n = n.replace('\u2122', '').replace('\u00ae', '').replace('\u00a9', '')
    n = re.sub(r'[^a-z0-9\s]', ' ', n)
    n = re.sub(r'\s+', ' ', n).strip()
    return n

def strip_edition(name: str) -> str:
    if not name:
        return ''
    n = name
    # Keywords that ALWAYS mean an edition (safe to match alone)
    safe_kw = (
        r"Definitive|Complete|GOTY|Game of the Year|"
        r"Remastered|HD|Director'?s?\s*Cut|Anniversary|Final\s*Cut"
    )
    # Keywords that need "Edition/Cut/Version" after them (could be part of title)
    ambiguous_kw = (
        r"Ultimate|Enhanced|Deluxe|Special|Legendary|Premium|Gold|Extended"
    )
    patterns = [
        # Safe keywords: match with or without "Edition" suffix
        rf"\s*[-\u2013\u2014:]\s*({safe_kw})\s*(Edition|Cut|Version)?.*$",
        rf"\s*\(({safe_kw})\s*(Edition)?\).*$",
        # Ambiguous keywords: REQUIRE "Edition/Cut/Version" after them
        rf"\s*[-\u2013\u2014:]\s*({ambiguous_kw})\s+(Edition|Cut|Version).*$",
        rf"\s*\(({ambiguous_kw})\s+(Edition)\).*$",
    ]
    for p in patterns:
        n = re.sub(p, '', n, flags=re.IGNORECASE)
    return n.strip()

def extract_numbers(name: str) -> List[str]:
    if not name:
        return []
    numbers = []
    for match in re.finditer(r'\b(\d+)\b', name):
        numbers.append(match.group(1))
    words = name.lower().split()
    for word in words:
        clean = re.sub(r'[^a-z]', '', word)
        if clean in ROMAN_MAP:
            numbers.append(ROMAN_MAP[clean])
    return numbers

def sequel_numbers_match(name_a: str, name_b: str) -> bool:
    nums_a = extract_numbers(name_a)
    nums_b = extract_numbers(name_b)
    if nums_a and nums_b:
        return bool(set(nums_a) & set(nums_b))
    if nums_a and not nums_b:
        if any(n.isdigit() and int(n) <= 30 for n in nums_a):
            return False
    if nums_b and not nums_a:
        if any(n.isdigit() and int(n) <= 30 for n in nums_b):
            return False
    return True

def find_best_match(target_name, candidates, name_key='name'):
    if not candidates:
        return None, 0.0, 'none'
    norm_target = normalize_name(target_name)
    best_match = None
    best_score = 0.0
    for candidate in candidates:
        cand_name = candidate.get(name_key, '')
        if not cand_name:
            continue
        if not sequel_numbers_match(target_name, cand_name):
            continue
        score = SequenceMatcher(None, norm_target, normalize_name(cand_name)).ratio()
        if score > best_score:
            best_score = score
            best_match = candidate
    if best_match is None or best_score < FUZZY_MATCH_THRESHOLD:
        return None, best_score, 'none'
    if best_score >= EXACT_MATCH_THRESHOLD:
        return best_match, best_score, 'exact'
    return best_match, best_score, 'fuzzy'

# ==================== LOAD FILES ====================

def load_igdb_database(filepath):
    print(f"  Loading: {filepath}")
    if not os.path.exists(filepath):
        print(f"  \u274c File not found: {filepath}")
        return []
    with open(filepath, 'r') as f:
        data = json.load(f)
    games = data if isinstance(data, list) else data.get('games', [])
    print(f"  Loaded {len(games)} IGDB games")
    return games

def load_rawg_data(filepath):
    print(f"  Loading: {filepath}")
    if not os.path.exists(filepath):
        print(f"  \u274c File not found: {filepath}")
        return []
    with open(filepath, 'r') as f:
        data = json.load(f)
    if isinstance(data, list):
        games = data
    elif isinstance(data, dict) and 'games' in data:
        games = data['games']
    else:
        print(f"  \u274c Unrecognized format")
        return []
    print(f"  Loaded {len(games)} RAWG games")
    return games

# ==================== DEDUPLICATION ====================

def deduplicate_games(games):
    """
    Remove edition duplicates while keeping genuinely different games.
    
    - Group by base name (stripped of edition suffixes)
    - If years are >5 apart: different games, keep both (e.g. God of War 2005 vs 2018)
    - If years are close or same: edition variant, keep the higher-ranked one
    """
    print(f"\n  Deduplicating {len(games)} games...")
    
    groups = {}
    for g in games:
        base = normalize_name(strip_edition(g['name']))
        if base not in groups:
            groups[base] = []
        groups[base].append(g)
    
    kept = []
    removed = []
    merge_log = []
    
    for base_name, group in groups.items():
        if len(group) == 1:
            kept.append(group[0])
            continue
        
        group.sort(key=lambda g: g.get('popularityRank', 9999))
        
        # Cluster by year (within 5 years = same era)
        year_groups = {}
        for g in group:
            year = g.get('year', 0)
            placed = False
            for anchor_year in year_groups:
                if abs(year - anchor_year) <= 5:
                    year_groups[anchor_year].append(g)
                    placed = True
                    break
            if not placed:
                year_groups[year] = [g]
        
        # Process each year cluster
        for anchor_year, year_group in year_groups.items():
            year_group.sort(key=lambda g: g.get('popularityRank', 9999))
            kept.append(year_group[0])
            for g in year_group[1:]:
                removed.append(g)
                merge_log.append({
                    'kept': year_group[0]['name'],
                    'kept_year': year_group[0].get('year'),
                    'kept_rank': year_group[0].get('popularityRank'),
                    'removed': g['name'],
                    'removed_year': g.get('year'),
                    'removed_rank': g.get('popularityRank'),
                })
    
    print(f"  \u2713 Kept {len(kept)} unique games, removed {len(removed)} duplicates")
    
    if merge_log:
        print(f"\n  REMOVED DUPLICATES ({len(merge_log)}):")
        for m in merge_log:
            print(f"    \u2717 \"{m['removed']}\" ({m['removed_year']}, rank {m['removed_rank']})")
            print(f"      \u2192 kept \"{m['kept']}\" ({m['kept_year']}, rank {m['kept_rank']})")
    
    with open('dedup_log.json', 'w') as f:
        json.dump(merge_log, f, indent=2)
    print(f"\n  \u2713 Saved dedup_log.json")
    
    return kept, removed

# ==================== IGDB BATCH FETCH ====================

def batch_fetch_igdb_rating_counts(igdb_games):
    if not IGDB_ENABLED:
        print("  \u26a0\ufe0f  IGDB disabled \u2014 skipping")
        return {}
    
    print(f"  Fetching rating counts for {len(igdb_games)} games...")
    url = "https://api.igdb.com/v4/games"
    headers = {
        'Client-ID': IGDB_CLIENT_ID,
        'Authorization': f'Bearer {IGDB_ACCESS_TOKEN}',
        'Accept': 'application/json'
    }
    
    all_ids = [g['id'] for g in igdb_games if g.get('id')]
    results = {}
    batch_size = 500
    
    for batch_start in range(0, len(all_ids), batch_size):
        batch_ids = all_ids[batch_start:batch_start + batch_size]
        batch_num = batch_start // batch_size + 1
        total_batches = (len(all_ids) + batch_size - 1) // batch_size
        
        id_list = ','.join(str(i) for i in batch_ids)
        body = f'''
        fields id, rating_count, total_rating_count, follows, hypes,
               aggregated_rating, aggregated_rating_count;
        where id = ({id_list});
        limit {batch_size};
        '''
        
        try:
            print(f"    Batch {batch_num}/{total_batches}...", end='', flush=True)
            response = requests.post(url, headers=headers, data=body, timeout=30)
            response.raise_for_status()
            data = response.json()
            for game in data:
                results[game['id']] = {
                    'igdb_rating_count': game.get('rating_count', 0),
                    'igdb_total_rating_count': game.get('total_rating_count', 0),
                    'igdb_follows': game.get('follows', 0),
                    'igdb_hypes': game.get('hypes', 0),
                }
            print(f" \u2713 {len(data)} results")
            time.sleep(0.5)
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 401:
                print(f"\n  \u274c IGDB auth failed")
                raise
            print(f" \u274c {e}")
        except Exception as e:
            print(f" \u274c {e}")
    
    print(f"  \u2713 Fetched {len(results)} rating counts")
    return results

# ==================== RAWG MATCHING ====================

def match_rawg_to_igdb(igdb_games, rawg_games):
    print(f"\n  Matching {len(rawg_games)} RAWG \u2192 {len(igdb_games)} IGDB games...")
    
    rawg_lookup = [{
        'name': rg.get('name', ''),
        'ratings_count': rg.get('ratings_count', 0),
        'added': rg.get('added', 0),
        'rating': rg.get('rating', 0),
        'metacritic': rg.get('metacritic'),
        'background_image': rg.get('background_image'),
    } for rg in rawg_games]
    
    rawg_by_name = {}
    match_log = []
    exact = fuzzy = failed = 0
    
    for i, igdb_game in enumerate(igdb_games):
        igdb_name = igdb_game.get('name', '')
        match, score, mtype = find_best_match(igdb_name, rawg_lookup)
        
        if match and mtype in ('exact', 'fuzzy'):
            rawg_by_name[igdb_name] = match
            if mtype == 'exact': exact += 1
            else:
                fuzzy += 1
                match_log.append({'igdb_name': igdb_name, 'rawg_name': match['name'], 'score': round(score, 3), 'match_type': 'fuzzy'})
        else:
            failed += 1
            match_log.append({'igdb_name': igdb_name, 'rawg_best': match['name'] if match else None, 'best_score': round(score, 3), 'match_type': 'no_match'})
        
        if (i + 1) % 200 == 0:
            print(f"    {i+1}/{len(igdb_games)}...")
    
    total = exact + fuzzy + failed
    print(f"\n  \u2713 Exact: {exact} | Fuzzy: {fuzzy} | Failed: {failed} | Rate: {(exact+fuzzy)/total*100:.1f}%")
    return rawg_by_name, match_log

# ==================== BUILD & RANK ====================

def build_enriched_list(igdb_games, igdb_ratings, rawg_matches):
    enriched = []
    for game in igdb_games:
        igdb_id = game.get('id')
        igdb_name = game.get('name', '')
        
        rd = igdb_ratings.get(igdb_id, {})
        igdb_rc = rd.get('igdb_rating_count', 0)
        igdb_follows = rd.get('igdb_follows', 0)
        
        rawg = rawg_matches.get(igdb_name, {})
        rawg_rc = rawg.get('ratings_count', 0)
        rawg_added = rawg.get('added', 0)
        
        cover_url = game.get('coverUrl', '')
        if cover_url and not cover_url.startswith('http'):
            cover_url = 'https:' + cover_url
        if not cover_url and rawg.get('background_image'):
            cover_url = rawg['background_image']
        
        enriched.append({
            'igdb_id': igdb_id,
            'name': igdb_name,
            'year': game.get('year'),
            'igdb_rating_count': igdb_rc,
            'rawg_ratings_count': rawg_rc,
            'combined_rating_count': igdb_rc + rawg_rc,
            'igdb_rating': game.get('rating'),
            'igdb_popularity': game.get('popularity'),
            'igdb_original_rank': game.get('popularityRank'),
            'igdb_follows': igdb_follows,
            'rawg_added': rawg_added,
            'metacritic': rawg.get('metacritic'),
            'rawg_matched': bool(rawg),
            'primaryGenre': game.get('primaryGenre'),
            'genres': game.get('genres', []),
            'platform': game.get('platform'),
            'allPlatforms': game.get('allPlatforms', []),
            'perspective': game.get('perspective'),
            'themes': game.get('themes', []),
            'primaryTheme': game.get('primaryTheme'),
            'gameModes': game.get('gameModes', []),
            'isMultiplayer': game.get('isMultiplayer'),
            'publisher': game.get('publisher'),
            'franchise': game.get('franchise'),
            'description': game.get('description'),
            'cover_image': cover_url,
            'protagonistGender': game.get('protagonistGender'),
            'protagonistType': game.get('protagonistType'),
            'artStyle': game.get('artStyle'),
            'setting': game.get('setting'),
        })
    
    enriched.sort(key=lambda g: g['combined_rating_count'], reverse=True)
    for i, game in enumerate(enriched, 1):
        game['rank'] = i
    
    return enriched

# ==================== CSV OUTPUT ====================

def save_ranking_csv(games):
    columns = [
        'rank', 'name', 'year', 'combined_rating_count',
        'igdb_rating_count', 'rawg_ratings_count',
        'igdb_rating', 'igdb_popularity', 'igdb_original_rank',
        'igdb_follows', 'rawg_added', 'metacritic', 'rawg_matched',
        'primaryGenre', 'publisher', 'franchise', 'platform',
        'perspective', 'primaryTheme', 'isMultiplayer', 'igdb_id',
    ]
    
    with open(RANKING_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        for game in games:
            row = {k: game.get(k, '') for k in columns}
            for k in row:
                if row[k] is None: row[k] = ''
                elif isinstance(row[k], bool): row[k] = 'Yes' if row[k] else 'No'
            writer.writerow(row)
    
    print(f"  \u2713 {RANKING_CSV} ({len(games)} games)")

def save_match_log(match_log):
    fuzzy = [m for m in match_log if m['match_type'] == 'fuzzy']
    no_match = [m for m in match_log if m['match_type'] == 'no_match']
    output = {
        'generated': datetime.now().isoformat(),
        'summary': {'fuzzy': len(fuzzy), 'no_match': len(no_match)},
        'fuzzy_matches': fuzzy,
        'no_matches': no_match,
    }
    with open(MATCH_LOG_FILE, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"  \u2713 {MATCH_LOG_FILE}")
    if fuzzy:
        print(f"\n  \u26a0\ufe0f  FUZZY MATCHES ({len(fuzzy)}):")
        for m in fuzzy[:10]:
            print(f"    \"{m['igdb_name']}\" \u2192 \"{m['rawg_name']}\" ({m['score']:.0%})")
        if len(fuzzy) > 10:
            print(f"    ... and {len(fuzzy) - 10} more")

# ==================== CONSOLE REPORT ====================

def print_report(games):
    total = len(games)
    print(f"\n  \u2500\u2500 TOP 20 \u2500\u2500")
    print(f"  {'Rank':>5}  {'Game':<42}  {'Year':>4}  {'Combined':>9}  {'IGDB':>6}  {'RAWG':>6}  {'Genre':<15}")
    print(f"  {'_'*5}  {'_'*42}  {'_'*4}  {'_'*9}  {'_'*6}  {'_'*6}  {'_'*15}")
    for g in games[:20]:
        print(f"  {g['rank']:5d}  {g['name'][:42]:<42}  {g.get('year',''):>4}  {g['combined_rating_count']:>9,}  {g['igdb_rating_count']:>6,}  {g['rawg_ratings_count']:>6,}  {(g.get('primaryGenre') or '')[:15]}")
    
    print(f"\n  \u2500\u2500 BOTTOM 20 (#{total-19}\u2013#{total}) \u2500\u2500")
    for g in games[-20:]:
        print(f"  {g['rank']:5d}  {g['name'][:42]:<42}  {g.get('year',''):>4}  {g['combined_rating_count']:>9,}  {g['igdb_rating_count']:>6,}  {g['rawg_ratings_count']:>6,}  {(g.get('primaryGenre') or '')[:15]}")
    
    genre_counts = {}
    for g in games:
        genre = g.get('primaryGenre') or 'Unknown'
        genre_counts[genre] = genre_counts.get(genre, 0) + 1
    
    print(f"\n  \u2500\u2500 GENRE DISTRIBUTION \u2500\u2500")
    for genre, count in sorted(genre_counts.items(), key=lambda x: x[1], reverse=True)[:10]:
        bar = '\u2588' * (count // 5)
        print(f"    {genre:<25} {count:4d}  {bar}")
    
    with_rawg = sum(1 for g in games if g.get('rawg_matched'))
    with_igdb_rc = sum(1 for g in games if g['igdb_rating_count'] > 0)
    with_cover = sum(1 for g in games if g.get('cover_image'))
    
    print(f"\n  \u2500\u2500 COVERAGE \u2500\u2500")
    print(f"    Total games:            {total}")
    print(f"    With IGDB rating count: {with_igdb_rc} ({with_igdb_rc/total*100:.1f}%)")
    print(f"    With RAWG match:        {with_rawg} ({with_rawg/total*100:.1f}%)")
    print(f"    With cover image:       {with_cover} ({with_cover/total*100:.1f}%)")

# ==================== MAIN ====================

def main():
    print("\n" + "="*70)
    print("  METAGUESS TOP 1000 BUILDER v2")
    print("  IGDB + RAWG \u2192 deduplicate \u2192 rank \u2192 CSV for review")
    print("="*70)
    print(f"  Date:  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  IGDB API: {'Enabled' if IGDB_ENABLED else 'Disabled'}")
    
    start_time = time.time()
    skip_igdb_fetch = '--skip-igdb-fetch' in sys.argv
    
    igdb_file = IGDB_DATABASE_FILE
    rawg_file = RAWG_DATA_FILE
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == '--igdb-file' and i < len(sys.argv) - 1:
            igdb_file = sys.argv[i + 1]
        elif arg == '--rawg-file' and i < len(sys.argv) - 1:
            rawg_file = sys.argv[i + 1]
    
    print("\n" + "-"*70)
    print("  STEP 1: Load IGDB Database")
    print("-"*70)
    igdb_games = load_igdb_database(igdb_file)
    if not igdb_games: return
    
    print("\n" + "-"*70)
    print("  STEP 2: Deduplicate Editions")
    print("-"*70)
    igdb_games, removed = deduplicate_games(igdb_games)
    
    print("\n" + "-"*70)
    print("  STEP 3: Fetch IGDB Rating Counts")
    print("-"*70)
    if skip_igdb_fetch:
        print("  Skipped (--skip-igdb-fetch)")
        igdb_ratings = {}
    elif IGDB_ENABLED:
        igdb_ratings = batch_fetch_igdb_rating_counts(igdb_games)
    else:
        print("  \u26a0\ufe0f  IGDB API disabled \u2014 rating counts will be 0")
        igdb_ratings = {}
    
    print("\n" + "-"*70)
    print("  STEP 4: Match RAWG Data")
    print("-"*70)
    rawg_games = load_rawg_data(rawg_file)
    if rawg_games:
        rawg_matches, match_log = match_rawg_to_igdb(igdb_games, rawg_games)
    else:
        print("  \u26a0\ufe0f  No RAWG data")
        rawg_matches = {}
        match_log = []
    
    print("\n" + "-"*70)
    print("  STEP 5: Combine & Rank")
    print("-"*70)
    all_games = build_enriched_list(igdb_games, igdb_ratings, rawg_matches)
    
    print("\n" + "-"*70)
    print("  STEP 6: Save")
    print("-"*70)
    save_ranking_csv(all_games)
    if match_log:
        save_match_log(match_log)
    
    # Save full JSON data (finalize script needs this)
    with open('ranking_full_data.json', 'w') as f:
        json.dump(all_games, f, indent=2)
    print(f"  \u2713 ranking_full_data.json (full data for finalize script)")
    
    print("\n" + "-"*70)
    print("  STEP 7: Summary")
    print("-"*70)
    print_report(all_games)
    
    elapsed = time.time() - start_time
    m, s = int(elapsed // 60), int(elapsed % 60)
    
    print(f"\n{'='*70}")
    print(f"  \u2705 DONE \u2014 {len(all_games)} games ranked in {m}m {s}s")
    print(f"")
    print(f"  NEXT STEPS:")
    print(f"    1. Open {RANKING_CSV} in Excel/Numbers")
    print(f"    2. Review \u2014 delete rows you don't want")
    print(f"    3. Save the CSV")
    print(f"    4. Run: python metaguess_finalize.py")
    print(f"       \u2192 Outputs metaguess_games.json (re-ranked 1 to N)")
    print(f"{'='*70}\n")

if __name__ == '__main__':
    if '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
        sys.exit(0)
    
    if not IGDB_ENABLED:
        print("\n  \u26a0\ufe0f  IGDB API not configured \u2014 ranking uses RAWG counts only")
        print("     To enable: set IGDB_CLIENT_ID, IGDB_ACCESS_TOKEN, IGDB_ENABLED = True")
        print("")
        try:
            proceed = input("  Continue without IGDB rating counts? (y/n): ")
            if proceed.lower() != 'y': sys.exit(0)
        except (EOFError, KeyboardInterrupt):
            sys.exit(0)
    
    main()

#!/usr/bin/env python3
"""
Metaguess Database Builder v3
Reads pre-fetched RAWG data → enriches with IGDB (fuzzy matching) → outputs final database

Usage:
  python metaguess_database_builder.py                          # Uses default input file
  python metaguess_database_builder.py rawg_top1000_robust.json # Specify input file
  python metaguess_database_builder.py --resume                 # Resume from last checkpoint
"""

import requests
import json
import time
import re
import sys
import os
import glob
from difflib import SequenceMatcher
from datetime import datetime
from typing import Dict, List, Optional, Tuple

# ==================== CONFIGURATION ====================

# IGDB Credentials (get from https://dev.twitch.tv/console)
IGDB_CLIENT_ID = 'uijc7itihbez5spq8wj3pvxnidsani'
IGDB_ACCESS_TOKEN = 'lcnxsfe58yfx049xveirl7lj44fne7'

# Set to True once you've added your credentials above
IGDB_ENABLED = True

# Fuzzy match settings
EXACT_MATCH_THRESHOLD = 0.95   # Above this = auto-accept (near-identical)
FUZZY_MATCH_THRESHOLD = 0.70   # Below this = reject (too different)

# Input file - output from fetch_rawg_robust.py
DEFAULT_INPUT_FILE = 'rawg_top1000_robust.json'

# Output files
OUTPUT_FULL = 'metaguess_database.json'
OUTPUT_SIMPLE = 'metaguess_games.json'
MISMATCH_LOG = 'igdb_match_log.json'
CHECKPOINT_DIR = 'checkpoints'

# ==================== NAME MATCHING ====================

# Roman numeral mapping
ROMAN_MAP = {
    'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5',
    'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10',
    'xi': '11', 'xii': '12', 'xiii': '13', 'xiv': '14', 'xv': '15',
    'xvi': '16', 'xvii': '17', 'xviii': '18', 'xix': '19', 'xx': '20',
}

def normalize_name(name: str) -> str:
    """
    Normalize a game name for comparison.
    Strips prefixes, punctuation, extra whitespace, lowercases.
    """
    if not name:
        return ''
    
    n = name.lower().strip()
    
    # Remove common prefixes
    for prefix in ['the ', 'a ']:
        if n.startswith(prefix):
            n = n[len(prefix):]
    
    # Remove trademark/copyright symbols
    n = n.replace('™', '').replace('®', '').replace('©', '')
    
    # Remove edition/version suffixes that differ between sources
    edition_patterns = [
        r'\s*[-–—:]\s*(definitive|ultimate|complete|goty|game of the year|'
        r'enhanced|remastered|deluxe|special|legendary|premium|gold)\s*edition.*$',
        r'\s*\((definitive|ultimate|complete|goty|game of the year|'
        r'enhanced|remastered|deluxe|special|legendary|premium|gold)\s*edition\).*$',
    ]
    for pattern in edition_patterns:
        n = re.sub(pattern, '', n, flags=re.IGNORECASE)
    
    # Normalize punctuation: keep alphanumeric and spaces
    n = re.sub(r'[^a-z0-9\s]', ' ', n)
    
    # Collapse whitespace
    n = re.sub(r'\s+', ' ', n).strip()
    
    return n

def extract_numbers(name: str) -> List[str]:
    """
    Extract all numbers (arabic + roman numerals) from a game name.
    Returns them as strings of arabic numbers for comparison.
    
    "Final Fantasy VII"     → ['7']
    "Halo 3"                → ['3']
    "Battlefield 2042"      → ['2042']
    """
    if not name:
        return []
    
    numbers = []
    
    # Find arabic numbers
    for match in re.finditer(r'\b(\d+)\b', name):
        numbers.append(match.group(1))
    
    # Find roman numerals (must be standalone words)
    words = name.lower().split()
    for word in words:
        clean = re.sub(r'[^a-z]', '', word)
        if clean in ROMAN_MAP:
            numbers.append(ROMAN_MAP[clean])
    
    return numbers

def sequel_numbers_match(rawg_name: str, igdb_name: str) -> bool:
    """
    Check if sequel numbers are compatible.
    If BOTH names have numbers, they must share at least one.
    If only one has a small sequel number (1-30), reject it.
    """
    rawg_nums = extract_numbers(rawg_name)
    igdb_nums = extract_numbers(igdb_name)
    
    # If both have numbers, at least one must overlap
    if rawg_nums and igdb_nums:
        return bool(set(rawg_nums) & set(igdb_nums))
    
    # If only one side has a small sequel number, probably wrong game
    if rawg_nums and not igdb_nums:
        small_nums = [n for n in rawg_nums if n.isdigit() and int(n) <= 30]
        if small_nums:
            return False
    if igdb_nums and not rawg_nums:
        small_nums = [n for n in igdb_nums if n.isdigit() and int(n) <= 30]
        if small_nums:
            return False
    
    return True

def similarity_score(name_a: str, name_b: str) -> float:
    """Calculate similarity between two normalized names (0.0 to 1.0)."""
    return SequenceMatcher(None, name_a, name_b).ratio()

def find_best_igdb_match(rawg_name: str, igdb_results: List[Dict]) -> Tuple[Optional[Dict], float, str]:
    """
    Find the best IGDB match for a RAWG game name.
    Returns (best_match, score, match_type):
      'exact'  — near-identical names
      'fuzzy'  — different but passed checks
      'none'   — no acceptable match
    """
    if not igdb_results:
        return None, 0.0, 'none'
    
    norm_rawg = normalize_name(rawg_name)
    
    best_match = None
    best_score = 0.0
    
    for result in igdb_results:
        igdb_name = result.get('name', '')
        norm_igdb = normalize_name(igdb_name)
        
        # Skip if sequel numbers conflict
        if not sequel_numbers_match(rawg_name, igdb_name):
            continue
        
        score = similarity_score(norm_rawg, norm_igdb)
        
        if score > best_score:
            best_score = score
            best_match = result
    
    if best_match is None or best_score < FUZZY_MATCH_THRESHOLD:
        return None, best_score, 'none'
    
    if best_score >= EXACT_MATCH_THRESHOLD:
        return best_match, best_score, 'exact'
    
    return best_match, best_score, 'fuzzy'

# ==================== LOAD RAWG DATA ====================

def load_rawg_data(filepath: str) -> List[Dict]:
    """
    Load pre-fetched RAWG data from JSON file.
    Auto-detects wrapper format vs plain array.
    """
    print(f"\n  Loading: {filepath}")
    
    if not os.path.exists(filepath):
        print(f"\n  ❌ File not found: {filepath}")
        print(f"     Run fetch_rawg_robust.py first to generate RAWG data.")
        return []
    
    with open(filepath, 'r') as f:
        data = json.load(f)
    
    if isinstance(data, list):
        games = data
        print(f"  Format:  Plain array")
    elif isinstance(data, dict) and 'games' in data:
        games = data['games']
        fetched_at = data.get('fetched_at', 'unknown')
        failed = data.get('failed_pages', [])
        print(f"  Format:  Wrapper (fetched: {fetched_at})")
        if failed:
            print(f"  ⚠️  Note: Original fetch had {len(failed)} failed pages: {failed}")
    else:
        print(f"\n  ❌ Unrecognized JSON format in {filepath}")
        return []
    
    print(f"  Games:   {len(games)}")
    return games

# ==================== EXTRACT RAWG FIELDS ====================

def extract_rawg_data(rawg_game: Dict) -> Dict:
    """Extract and normalize relevant fields from raw RAWG API data."""
    platforms = rawg_game.get('platforms', [])
    platform_names = []
    if platforms:
        for p in platforms:
            if isinstance(p, dict) and 'platform' in p:
                platform_names.append(p['platform']['name'])
            elif isinstance(p, str):
                platform_names.append(p)
    
    genres = rawg_game.get('genres', [])
    genre_names = []
    if genres:
        for g in genres:
            if isinstance(g, dict) and 'name' in g:
                genre_names.append(g['name'])
            elif isinstance(g, str):
                genre_names.append(g)
    
    released = rawg_game.get('released', '')
    year = None
    if released and isinstance(released, str) and '-' in released:
        try:
            year = int(released.split('-')[0])
        except ValueError:
            pass
    
    return {
        'rawg_id': rawg_game.get('id'),
        'name': rawg_game.get('name'),
        'year': year,
        'rawg_slug': rawg_game.get('slug'),
        'rawg_added': rawg_game.get('added', 0),
        'rawg_rating': rawg_game.get('rating', 0),
        'rawg_ratings_count': rawg_game.get('ratings_count', 0),
        'rawg_reviews_count': rawg_game.get('reviews_count', 0),
        'metacritic': rawg_game.get('metacritic'),
        'playtime': rawg_game.get('playtime', 0),
        'platforms': platform_names,
        'genres': genre_names,
        'esrb_rating': rawg_game.get('esrb_rating', {}).get('name') if rawg_game.get('esrb_rating') else None,
        'rawg_background_image': rawg_game.get('background_image'),
    }

# ==================== IGDB ENRICHMENT ====================

def fetch_igdb_candidates(game_name: str) -> List[Dict]:
    """Fetch up to 10 candidate matches from IGDB."""
    url = "https://api.igdb.com/v4/games"
    headers = {
        'Client-ID': IGDB_CLIENT_ID,
        'Authorization': f'Bearer {IGDB_ACCESS_TOKEN}',
        'Accept': 'application/json'
    }
    
    safe_name = game_name.replace('"', '\\"')
    
    body = f'''
    search "{safe_name}";
    fields 
        name,
        rating,
        rating_count,
        total_rating,
        total_rating_count,
        follows,
        hypes,
        aggregated_rating,
        aggregated_rating_count,
        cover.url,
        cover.image_id,
        genres.name,
        themes.name,
        game_modes.name,
        player_perspectives.name,
        involved_companies.company.name,
        involved_companies.publisher;
    limit 10;
    '''
    
    try:
        response = requests.post(url, headers=headers, data=body, timeout=15)
        response.raise_for_status()
        return response.json() or []
        
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 401:
            print(f"\n  ❌ IGDB auth failed - token may be expired. See guide to refresh.")
            raise
        print(f"  ⚠️  IGDB HTTP error for '{game_name[:40]}': {e}")
        return []
    except requests.exceptions.Timeout:
        print(f"  ⏱️  IGDB timeout for '{game_name[:40]}'")
        return []
    except Exception as e:
        print(f"  ⚠️  IGDB error for '{game_name[:40]}': {e}")
        return []

def extract_igdb_fields(game: Dict) -> Dict:
    """Extract the fields we need from a single IGDB result."""
    companies = game.get('involved_companies', [])
    publisher = None
    for company in companies:
        if company.get('publisher'):
            publisher = company.get('company', {}).get('name')
            break
    
    genres = game.get('genres', [])
    primary_genre = genres[0]['name'] if genres else None
    
    cover = game.get('cover', {})
    cover_url = None
    if cover and cover.get('url'):
        cover_url = 'https:' + cover['url']
        cover_url = cover_url.replace('t_thumb', 't_cover_big')
    
    return {
        'igdb_id': game.get('id'),
        'igdb_name': game.get('name'),
        'igdb_rating': game.get('rating'),
        'igdb_rating_count': game.get('rating_count'),
        'igdb_total_rating': game.get('total_rating'),
        'igdb_follows': game.get('follows'),
        'igdb_hypes': game.get('hypes'),
        'igdb_aggregated_rating': game.get('aggregated_rating'),
        'igdb_aggregated_rating_count': game.get('aggregated_rating_count'),
        'cover_image': cover_url,
        'primaryGenre': primary_genre,
        'publisher': publisher,
        'game_modes': [m['name'] for m in game.get('game_modes', [])],
        'themes': [t['name'] for t in game.get('themes', [])],
        'player_perspectives': [p['name'] for p in game.get('player_perspectives', [])],
    }

# ==================== BUILD DATABASE ====================

def load_checkpoint() -> Tuple[List[Dict], int, List[Dict]]:
    """Load most recent checkpoint. Returns (games, start_index, match_log)."""
    if not os.path.exists(CHECKPOINT_DIR):
        return [], 0, []
    
    checkpoints = sorted(glob.glob(os.path.join(CHECKPOINT_DIR, 'checkpoint_*.json')))
    if not checkpoints:
        return [], 0, []
    
    latest = checkpoints[-1]
    print(f"  Found checkpoint: {latest}")
    
    with open(latest, 'r') as f:
        data = json.load(f)
    
    games = data.get('games', [])
    log = data.get('match_log', [])
    
    print(f"  Contains {len(games)} processed games, {len(log)} match log entries")
    return games, len(games), log

def save_checkpoint(games: List[Dict], match_log: List[Dict], index: int):
    """Save progress checkpoint (includes match log)"""
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    filepath = os.path.join(CHECKPOINT_DIR, f'checkpoint_{index:04d}.json')
    with open(filepath, 'w') as f:
        json.dump({'games': games, 'match_log': match_log}, f)

def build_database(rawg_games: List[Dict], resume: bool = False) -> Tuple[List[Dict], List[Dict]]:
    """
    Process RAWG games: extract fields, optionally enrich with IGDB.
    Returns (games, match_log).
    """
    print("\n" + "="*70)
    print("BUILDING DATABASE")
    print("="*70)
    
    processed = []
    match_log = []
    start_index = 0
    
    if resume:
        processed, start_index, match_log = load_checkpoint()
        if start_index > 0:
            print(f"  Resuming from game {start_index + 1}")
        else:
            print(f"  No checkpoint found, starting fresh")
    
    total = len(rawg_games)
    igdb_exact = 0
    igdb_fuzzy = 0
    igdb_failed = 0
    
    if IGDB_ENABLED:
        print(f"  IGDB: Enabled — will enrich each game (~{(total - start_index) * 0.4:.0f}s estimated)")
        print(f"  Match thresholds: exact ≥{EXACT_MATCH_THRESHOLD:.0%} | fuzzy ≥{FUZZY_MATCH_THRESHOLD:.0%}")
    else:
        print(f"  IGDB: Disabled — RAWG data only (no cover images or publisher info)")
    print(f"  Processing games {start_index + 1} to {total}...")
    print("")
    
    for i in range(start_index, total):
        rawg_game = rawg_games[i]
        game_data = extract_rawg_data(rawg_game)
        game_name = game_data['name'] or 'Unknown'
        
        if IGDB_ENABLED:
            candidates = fetch_igdb_candidates(game_name)
            best_match, score, match_type = find_best_igdb_match(game_name, candidates)
            
            if best_match and match_type in ('exact', 'fuzzy'):
                igdb_fields = extract_igdb_fields(best_match)
                igdb_name = igdb_fields.pop('igdb_name', '')
                game_data.update(igdb_fields)
                
                if not game_data.get('cover_image'):
                    game_data['cover_image'] = game_data.get('rawg_background_image')
                
                if match_type == 'exact':
                    igdb_exact += 1
                    print(f"  [{i+1:4d}/{total}] {game_name[:45]:<45} ✓ exact ({score:.0%})")
                else:
                    igdb_fuzzy += 1
                    print(f"  [{i+1:4d}/{total}] {game_name[:45]:<45} ~ fuzzy ({score:.0%})")
                    print(f"           RAWG: \"{game_name}\"")
                    print(f"           IGDB: \"{igdb_name}\"")
                    
                    match_log.append({
                        'rank': i + 1,
                        'rawg_name': game_name,
                        'igdb_name': igdb_name,
                        'score': round(score, 3),
                        'match_type': 'fuzzy',
                        'accepted': True,
                    })
            else:
                igdb_failed += 1
                game_data['cover_image'] = game_data.get('rawg_background_image')
                
                if candidates:
                    rejected_names = [c.get('name', '?') for c in candidates[:3]]
                    print(f"  [{i+1:4d}/{total}] {game_name[:45]:<45} ✗ no match ({score:.0%})")
                    
                    match_log.append({
                        'rank': i + 1,
                        'rawg_name': game_name,
                        'igdb_candidates': rejected_names,
                        'best_score': round(score, 3),
                        'match_type': 'rejected',
                        'accepted': False,
                    })
                else:
                    print(f"  [{i+1:4d}/{total}] {game_name[:45]:<45} ✗ no results")
                    
                    match_log.append({
                        'rank': i + 1,
                        'rawg_name': game_name,
                        'match_type': 'no_results',
                        'accepted': False,
                    })
            
            time.sleep(0.35)
        else:
            game_data['cover_image'] = game_data.get('rawg_background_image')
            if (i + 1) % 100 == 0 or i == total - 1:
                print(f"  Processed {i+1}/{total} games...")
        
        game_data['rank'] = i + 1
        processed.append(game_data)
        
        # Checkpoint every 100 games
        if IGDB_ENABLED and (i + 1) % 100 == 0:
            save_checkpoint(processed, match_log, i + 1)
            total_matched = igdb_exact + igdb_fuzzy
            total_tried = total_matched + igdb_failed
            pct = total_matched / total_tried * 100 if total_tried > 0 else 0
            print(f"         💾 Checkpoint | Match rate: {pct:.0f}% (exact: {igdb_exact}, fuzzy: {igdb_fuzzy}, failed: {igdb_failed})")
    
    # Summary
    print(f"\n  ✓ Processed {len(processed)} games")
    if IGDB_ENABLED:
        total_matched = igdb_exact + igdb_fuzzy
        total_tried = total_matched + igdb_failed
        print(f"    Exact matches:  {igdb_exact}")
        print(f"    Fuzzy matches:  {igdb_fuzzy}")
        print(f"    Failed:         {igdb_failed}")
        if total_tried > 0:
            print(f"    Match rate:     {total_matched/total_tried*100:.1f}%")
    
    return processed, match_log

# ==================== SAVE & EXPORT ====================

def save_database(games: List[Dict]):
    """Save full database with metadata wrapper"""
    output = {
        'version': datetime.now().strftime('%Y-%m-%d'),
        'total_games': len(games),
        'source': 'RAWG (popularity) + IGDB (attributes)' if IGDB_ENABLED else 'RAWG only',
        'igdb_enriched': IGDB_ENABLED,
        'last_updated': datetime.now().isoformat(),
        'games': games
    }
    
    with open(OUTPUT_FULL, 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"  ✓ {OUTPUT_FULL} (full with metadata)")

def save_simple(games: List[Dict]):
    """Save simple array — this is what metaguess loads"""
    with open(OUTPUT_SIMPLE, 'w') as f:
        json.dump(games, f, indent=2)
    
    print(f"  ✓ {OUTPUT_SIMPLE} (load this in metaguess)")

def save_match_log(match_log: List[Dict]):
    """
    Save the match log for manual review.
    Contains all fuzzy matches, rejections, and failures.
    """
    fuzzy = [m for m in match_log if m['match_type'] == 'fuzzy']
    rejected = [m for m in match_log if m['match_type'] == 'rejected']
    no_results = [m for m in match_log if m['match_type'] == 'no_results']
    
    output = {
        'generated': datetime.now().isoformat(),
        'summary': {
            'fuzzy_matches': len(fuzzy),
            'rejected_matches': len(rejected),
            'no_igdb_results': len(no_results),
            'total_issues': len(match_log),
        },
        'fuzzy_matches': fuzzy,
        'rejected_matches': rejected,
        'no_igdb_results': no_results,
    }
    
    with open(MISMATCH_LOG, 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"  ✓ {MISMATCH_LOG} (review fuzzy matches & failures)")
    
    # Print quick summary
    if fuzzy:
        print(f"\n  ⚠️  FUZZY MATCHES TO REVIEW ({len(fuzzy)}):")
        for m in fuzzy[:15]:
            print(f"    #{m['rank']:4d}  \"{m['rawg_name']}\"  →  \"{m['igdb_name']}\"  ({m['score']:.0%})")
        if len(fuzzy) > 15:
            print(f"    ... and {len(fuzzy) - 15} more (see {MISMATCH_LOG})")
    
    if rejected:
        print(f"\n  ✗  REJECTED / NO MATCH ({len(rejected)}):")
        for m in rejected[:15]:
            candidates = ', '.join(m.get('igdb_candidates', [])[:2])
            print(f"    #{m['rank']:4d}  \"{m['rawg_name']}\"  (best IGDB: {candidates}) ({m['best_score']:.0%})")
        if len(rejected) > 15:
            print(f"    ... and {len(rejected) - 15} more (see {MISMATCH_LOG})")
    
    if no_results:
        print(f"\n  ✗  NO IGDB RESULTS ({len(no_results)}):")
        for m in no_results[:10]:
            print(f"    #{m['rank']:4d}  \"{m['rawg_name']}\"")
        if len(no_results) > 10:
            print(f"    ... and {len(no_results) - 10} more (see {MISMATCH_LOG})")

# ==================== STATS REPORT ====================

def generate_report(games: List[Dict]):
    """Print database statistics"""
    total = len(games)
    if total == 0:
        print("  No games to report on.")
        return
    
    total_added = sum(g.get('rawg_added', 0) for g in games)
    avg_added = total_added / total
    
    rated = [g for g in games if g.get('rawg_rating')]
    avg_rating = sum(g['rawg_rating'] for g in rated) / len(rated) if rated else 0
    
    meta = [g for g in games if g.get('metacritic')]
    avg_meta = sum(g['metacritic'] for g in meta) / len(meta) if meta else 0
    
    igdb_games = [g for g in games if g.get('igdb_id')]
    cover_games = [g for g in games if g.get('cover_image')]
    
    platform_counts = {}
    for game in games:
        for p in game.get('platforms', []):
            platform_counts[p] = platform_counts.get(p, 0) + 1
    top_platforms = sorted(platform_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    
    print(f"""
  OVERVIEW
    Total Games:           {total:,}
    Generated:             {datetime.now().strftime('%Y-%m-%d %H:%M')}
    
  POPULARITY (RAWG)
    Avg 'Added' Count:     {avg_added:,.0f} users/game
    Avg Rating:            {avg_rating:.2f}/5.0
    Avg Metacritic:        {avg_meta:.1f}/100
    With Metacritic:       {len(meta)} ({len(meta)/total*100:.1f}%)
    
  IGDB ENRICHMENT
    Matched:               {len(igdb_games)} ({len(igdb_games)/total*100:.1f}%)
    With Cover Image:      {len(cover_games)} ({len(cover_games)/total*100:.1f}%)
    
  TOP PLATFORMS""")
    
    for i, (platform, count) in enumerate(top_platforms, 1):
        print(f"    {i}. {platform:<25} {count:4d} ({count/total*100:.1f}%)")
    
    print(f"\n  TOP 10 MOST POPULAR")
    for i, game in enumerate(games[:10], 1):
        name = (game.get('name') or 'Unknown')[:42]
        added = game.get('rawg_added', 0)
        rating = game.get('rawg_rating', 0)
        print(f"    {i:2d}. {name:<42} {added:>7,} added | {rating:.2f}/5")

# ==================== MAIN ====================

def main():
    print("\n" + "="*70)
    print("  METAGUESS DATABASE BUILDER v3")
    print("  RAWG data → IGDB enrichment (fuzzy match) → final database")
    print("="*70)
    print(f"  Date:  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  IGDB:  {'Enabled' if IGDB_ENABLED else 'Disabled'}")
    
    start_time = time.time()
    
    resume = '--resume' in sys.argv
    
    input_file = DEFAULT_INPUT_FILE
    for arg in sys.argv[1:]:
        if not arg.startswith('--') and arg.endswith('.json'):
            input_file = arg
            break
    
    # Step 1: Load RAWG data
    print("\n" + "-"*70)
    print("  STEP 1: Load RAWG Data")
    print("-"*70)
    
    rawg_games = load_rawg_data(input_file)
    if not rawg_games:
        return
    
    # Step 2: Build database
    print("\n" + "-"*70)
    print("  STEP 2: Process & Enrich")
    print("-"*70)
    
    final_database, match_log = build_database(rawg_games, resume=resume)
    
    if not final_database:
        print("\n  ❌ No games processed")
        return
    
    # Step 3: Save
    print("\n" + "-"*70)
    print("  STEP 3: Save Database")
    print("-"*70)
    
    save_database(final_database)
    save_simple(final_database)
    
    # Step 4: Match log
    if match_log:
        print("\n" + "-"*70)
        print("  STEP 4: Match Log")
        print("-"*70)
        save_match_log(match_log)
    
    # Step 5: Report
    print("\n" + "-"*70)
    print(f"  STEP {'5' if match_log else '4'}: Statistics")
    print("-"*70)
    
    generate_report(final_database)
    
    # Done
    elapsed = time.time() - start_time
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)
    
    print(f"\n{'='*70}")
    print(f"  ✅ DONE — {len(final_database):,} games in {minutes}m {seconds}s")
    print(f"     Load {OUTPUT_SIMPLE} in your metaguess project")
    if match_log:
        print(f"     Review {MISMATCH_LOG} for fuzzy matches & failures")
    print(f"{'='*70}\n")

if __name__ == '__main__':
    if '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
        sys.exit(0)
    
    if not IGDB_ENABLED:
        print("\n  ⚠️  IGDB is not configured — you'll get RAWG data only")
        print("     (no cover images, publisher, or IGDB ratings)")
        print("")
        print("  To enable IGDB:")
        print("    1. Get credentials from https://dev.twitch.tv/console")
        print("    2. Edit this script: set IGDB_CLIENT_ID and IGDB_ACCESS_TOKEN")
        print("    3. Set IGDB_ENABLED = True")
        print("")
        
        try:
            proceed = input("  Continue with RAWG only? (y/n): ")
            if proceed.lower() != 'y':
                print("  Exiting.")
                sys.exit(0)
        except (EOFError, KeyboardInterrupt):
            print("\n  Exiting.")
            sys.exit(0)
    
    main()

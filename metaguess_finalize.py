#!/usr/bin/env python3
"""
Metaguess Finalize
Reads your edited ranking_review.csv → re-ranks → outputs metaguess_games.json

After you've reviewed the CSV in Excel/Numbers and deleted unwanted games:
  python metaguess_finalize.py
  python metaguess_finalize.py my_edited_ranking.csv   # custom filename
"""

import csv
import json
import sys
import os
from datetime import datetime

# ==================== CONFIGURATION ====================

DEFAULT_CSV = 'ranking_review.csv'
FULL_DATA_JSON = 'ranking_full_data.json'

OUTPUT_FULL = 'metaguess_database.json'
OUTPUT_SIMPLE = 'metaguess_games.json'

# ==================== MAIN ====================

def main():
    # Determine input CSV
    csv_file = DEFAULT_CSV
    for arg in sys.argv[1:]:
        if arg.endswith('.csv') and not arg.startswith('--'):
            csv_file = arg
            break
    
    print(f"\n{'='*70}")
    print(f"  METAGUESS FINALIZE")
    print(f"  CSV → re-rank → metaguess_games.json")
    print(f"{'='*70}")
    
    # Step 1: Read the edited CSV to get the list of kept games (by igdb_id)
    print(f"\n  Reading: {csv_file}")
    if not os.path.exists(csv_file):
        print(f"  ❌ File not found: {csv_file}")
        return
    
    kept_ids = []
    csv_edits = {}  # igdb_id → {field: value} for all CSV columns
    
    # Fields in the CSV that you might edit
    EDITABLE_FIELDS = ['name', 'publisher', 'primaryGenre', 'franchise', 'platform', 'perspective', 'primaryTheme', 'year']
    
    with open(csv_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            igdb_id = row.get('igdb_id', '').strip()
            if igdb_id:
                try:
                    iid = int(igdb_id)
                    kept_ids.append(iid)
                    edits = {}
                    for field in EDITABLE_FIELDS:
                        val = row.get(field, '').strip()
                        if val:
                            # Convert year back to int
                            if field == 'year':
                                try: val = int(val)
                                except ValueError: pass
                            edits[field] = val
                    csv_edits[iid] = edits
                except ValueError:
                    pass
    
    print(f"  Found {len(kept_ids)} games in CSV")
    
    # Step 2: Load full data JSON (has all the game attributes)
    print(f"\n  Loading: {FULL_DATA_JSON}")
    if not os.path.exists(FULL_DATA_JSON):
        print(f"  ❌ File not found: {FULL_DATA_JSON}")
        print(f"     Run metaguess_top1000_builder.py first")
        return
    
    with open(FULL_DATA_JSON, 'r') as f:
        all_games = json.load(f)
    
    print(f"  Loaded {len(all_games)} games from full data")
    
    # Step 3: Filter to only games that remain in the CSV
    kept_id_set = set(kept_ids)
    filtered = [g for g in all_games if g.get('igdb_id') in kept_id_set]
    
    # Preserve the CSV ordering (user may have reordered)
    id_to_csv_order = {igdb_id: i for i, igdb_id in enumerate(kept_ids)}
    filtered.sort(key=lambda g: id_to_csv_order.get(g.get('igdb_id'), 9999))
    
    # Step 4: Apply edits from CSV and re-rank
    total_edits = 0
    for game in filtered:
        igdb_id = game.get('igdb_id')
        if igdb_id not in csv_edits:
            continue
        edits = csv_edits[igdb_id]
        for field, new_val in edits.items():
            old_val = game.get(field)
            if str(new_val) != str(old_val):
                game[field] = new_val
                total_edits += 1
                print(f"    ✏️  {game.get('name', '?')[:35]:<35}  {field}: \"{old_val}\" → \"{new_val}\"")
    
    for i, game in enumerate(filtered, 1):
        game['rank'] = i
    
    removed_count = len(all_games) - len(filtered)
    print(f"\n  Kept:       {len(filtered)} games")
    print(f"  Removed:    {removed_count} games")
    if total_edits:
        print(f"  Edits:      {total_edits} field changes applied")
    
    # Step 5: Save
    print(f"\n  Saving...")
    
    # Full database with metadata
    output = {
        'version': datetime.now().strftime('%Y-%m-%d'),
        'total_games': len(filtered),
        'source': 'IGDB + RAWG (ranked by combined rating count, manually reviewed)',
        'last_updated': datetime.now().isoformat(),
        'games': filtered
    }
    with open(OUTPUT_FULL, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"  ✓ {OUTPUT_FULL} ({len(filtered)} games)")
    
    # Simple array for metaguess
    with open(OUTPUT_SIMPLE, 'w') as f:
        json.dump(filtered, f, indent=2)
    print(f"  ✓ {OUTPUT_SIMPLE} ({len(filtered)} games)")
    
    # Step 6: Quick report
    print(f"\n  ── TOP 10 ──")
    print(f"  {'Rank':>5}  {'Game':<45}  {'Year':>4}  {'Combined':>9}")
    print(f"  {'─'*5}  {'─'*45}  {'─'*4}  {'─'*9}")
    for g in filtered[:10]:
        print(f"  {g['rank']:5d}  {g['name'][:45]:<45}  {g.get('year',''):>4}  {g['combined_rating_count']:>9,}")
    
    if len(filtered) > 10:
        print(f"\n  ── BOTTOM 5 ──")
        for g in filtered[-5:]:
            print(f"  {g['rank']:5d}  {g['name'][:45]:<45}  {g.get('year',''):>4}  {g['combined_rating_count']:>9,}")
    
    # Completeness check
    missing_genre = sum(1 for g in filtered if not g.get('primaryGenre'))
    missing_publisher = sum(1 for g in filtered if not g.get('publisher'))
    missing_cover = sum(1 for g in filtered if not g.get('cover_image'))
    
    if missing_genre or missing_publisher or missing_cover:
        print(f"\n  ⚠️  COMPLETENESS:")
        if missing_genre: print(f"    Missing genre:     {missing_genre}")
        if missing_publisher: print(f"    Missing publisher: {missing_publisher}")
        if missing_cover: print(f"    Missing cover:     {missing_cover}")
    
    print(f"\n{'='*70}")
    print(f"  ✅ DONE — Load {OUTPUT_SIMPLE} in your metaguess project")
    print(f"{'='*70}\n")

if __name__ == '__main__':
    if '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
        sys.exit(0)
    main()

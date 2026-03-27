#!/usr/bin/env python3
"""
Ultra-Robust RAWG Fetcher
Two-pass system: Fetch all pages, then retry any failures
"""

import requests
import json
import time
from datetime import datetime

RAWG_API_KEY = 'c096f46036634c42ae085ed03eef411d'

def fetch_page(page_num, max_retries=10):
    """
    Fetch a single page with exponential backoff
    """
    base_url = 'https://api.rawg.io/api/games'
    params = {
        'key': RAWG_API_KEY,
        'page_size': 40,
        'ordering': '-added',
        'page': page_num
    }
    
    for attempt in range(max_retries):
        try:
            # Exponential backoff: 5s, 10s, 20s, 40s, etc.
            if attempt > 0:
                wait_time = min(5 * (2 ** (attempt - 1)), 60)  # Max 60 seconds
                print(f"    Retry {attempt}/{max_retries}, waiting {wait_time}s...", end='', flush=True)
                time.sleep(wait_time)
                print(" trying now...", end='', flush=True)
            else:
                print(f"  Page {page_num:2d}/25 - Attempt {attempt + 1}...", end='', flush=True)
            
            response = requests.get(base_url, params=params, timeout=60)
            response.raise_for_status()
            data = response.json()
            
            games = data.get('results', [])
            if games:
                print(f" ✓ Got {len(games)} games")
                return games, True
            else:
                print(" ⚠️ No results")
                return [], False
                
        except requests.exceptions.Timeout:
            print(f" ⏱️ Timeout", end='')
            if attempt == max_retries - 1:
                print(f" ❌ FAILED after {max_retries} attempts")
                return [], False
                
        except requests.exceptions.RequestException as e:
            print(f" ❌ Error: {str(e)[:50]}", end='')
            if attempt == max_retries - 1:
                print(f" ❌ FAILED after {max_retries} attempts")
                return [], False
                
        except Exception as e:
            print(f" ❌ Unexpected: {type(e).__name__}")
            return [], False
    
    return [], False

def fetch_all_pages():
    """
    Two-pass fetch system
    """
    print("="*70)
    print("ULTRA-ROBUST RAWG FETCHER - TWO-PASS SYSTEM")
    print("="*70)
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    
    all_games = {}  # Dict to store games by page number
    failed_pages = []
    
    # PASS 1: Try to fetch all 25 pages
    print("PASS 1: Fetching all pages (max 3 attempts each)")
    print("-"*70)
    
    for page in range(1, 26):
        games, success = fetch_page(page, max_retries=3)
        
        if success:
            all_games[page] = games
        else:
            failed_pages.append(page)
            print(f"  ⚠️  Page {page} marked for retry in Pass 2")
        
        # Rate limiting between pages
        if page < 25:
            time.sleep(2)
    
    # PASS 2: Retry failed pages with more attempts
    if failed_pages:
        print(f"\n{'='*70}")
        print(f"PASS 2: Retrying {len(failed_pages)} failed pages (max 10 attempts each)")
        print("-"*70)
        
        remaining_failures = []
        for page in failed_pages:
            print(f"\nRetrying page {page}...")
            games, success = fetch_page(page, max_retries=10)
            
            if success:
                all_games[page] = games
                print(f"  ✅ Page {page} recovered!")
            else:
                remaining_failures.append(page)
                print(f"  ❌ Page {page} still failed")
            
            time.sleep(3)  # Longer delay for retries
        
        failed_pages = remaining_failures
    
    # Compile results
    print(f"\n{'='*70}")
    print("RESULTS")
    print("-"*70)
    
    total_games = sum(len(games) for games in all_games.values())
    successful_pages = len(all_games)
    
    print(f"  Successful pages: {successful_pages}/25")
    print(f"  Total games:      {total_games}")
    
    if failed_pages:
        print(f"  ❌ Failed pages:   {failed_pages}")
        print(f"\n  WARNING: Missing games from pages {failed_pages}")
        print(f"           Rankings will be incomplete!")
    else:
        print(f"  ✅ All pages successful!")
    
    # Assemble in correct order
    final_games = []
    for page in range(1, 26):
        if page in all_games:
            final_games.extend(all_games[page])
        else:
            print(f"  ⚠️  Skipping page {page} (no data)")
    
    return final_games, failed_pages

def save_results(games, failed_pages):
    """
    Save the fetched games with metadata
    """
    # Add rank numbers
    for i, game in enumerate(games, 1):
        game['rank'] = i
    
    output = {
        'fetched_at': datetime.now().isoformat(),
        'total_games': len(games),
        'expected_games': 1000,
        'success': len(failed_pages) == 0,
        'failed_pages': failed_pages,
        'games': games
    }
    
    # Save main file
    filename = 'rawg_top1000_robust.json'
    with open(filename, 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"\n✓ Saved to: {filename}")
    
    # Save simple version (just games array)
    simple_filename = 'rawg_games_simple.json'
    with open(simple_filename, 'w') as f:
        json.dump(games, f, indent=2)
    
    print(f"✓ Saved to: {simple_filename}")
    
    # Show top 10
    print(f"\n{'='*70}")
    print("TOP 10 GAMES:")
    for i, game in enumerate(games[:10], 1):
        name = game.get('name', 'Unknown')
        added = game.get('added', 0)
        rating = game.get('rating', 0)
        print(f"  {i:2d}. {name:<40} {added:>7,} users | {rating:.2f}/5")
    
    print(f"{'='*70}")

def main():
    start_time = time.time()
    
    # Fetch games
    games, failed_pages = fetch_all_pages()
    
    # Save results
    save_results(games, failed_pages)
    
    # Summary
    elapsed = time.time() - start_time
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)
    
    print(f"\n{'='*70}")
    print(f"COMPLETE!")
    print(f"  Time elapsed: {minutes}m {seconds}s")
    
    if failed_pages:
        print(f"\n  ⚠️  WARNING: Pages {failed_pages} failed")
        print(f"      Try running again later when RAWG API is more stable")
    else:
        print(f"\n  ✅ SUCCESS: All 1000 games fetched!")
        print(f"      Ready to enrich with IGDB data")
    
    print(f"{'='*70}\n")

if __name__ == '__main__':
    main()

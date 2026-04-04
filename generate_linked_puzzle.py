"""
generate_linked_puzzle.py
─────────────────────────
Generates the word ranking data for a MetaGuess "Linked" puzzle.

SETUP (one time only):
  pip install gensim

  First run will download the GloVe model (~400MB) and cache it automatically.
  Every run after that loads from cache instantly.

USAGE:
  python generate_linked_puzzle.py

You'll be prompted to enter:
  - The connection word  (e.g. ISOLATION)
  - The day number       (e.g. 1)
  - 3 games (title + igdb_id)

Output is appended to linked-database.json in this folder.
"""

import json
import sys
from pathlib import Path

TOP_N = 3000
OUTPUT_PATH = Path(__file__).parent / "linked-database.json"


def load_vectors():
    try:
        import gensim.downloader as api
    except ImportError:
        print("gensim not installed. Run: pip install gensim")
        
        sys.exit(1)

    print("Loading GloVe vectors via gensim…")
    print("(First run downloads ~400MB and caches it — subsequent runs are instant)\n")
    model = api.load("glove-wiki-gigaword-300")
    print(f"  Loaded {len(model):,} word vectors\n")
    return model


def rank_words(connection: str, model) -> dict[str, int]:
    target = connection.lower()
    if target not in model:
        print(f"  ⚠️  '{target}' not found in GloVe vocabulary.")
        print("  Try a simpler form of the word (singular, no -ing, no -ed)")
        sys.exit(1)

    print(f"  Ranking all words against '{target}' …")
    similar = model.most_similar(target, topn=TOP_N)

    # Rank 1 = the target word itself
    word_ranks = {target: 1}
    for rank, (word, _) in enumerate(similar, start=2):
        word_ranks[word] = rank

    return word_ranks


def prompt_games() -> list[dict]:
    print("\nEnter the 3 games for this puzzle.")
    print("Format: Game Title | igdb_id")
    print("Example: Shadow of the Colossus | 1164\n")

    games = []
    while len(games) < 3:
        raw = input(f"  Game {len(games)+1}: ").strip()
        if not raw:
            print(f"  Need {3 - len(games)} more game(s)")
            continue
        if "|" not in raw:
            print("  Use the format: Title | igdb_id")
            continue
        parts = raw.split("|", 1)
        title = parts[0].strip()
        try:
            igdb_id = int(parts[1].strip())
        except ValueError:
            print("  igdb_id must be a number")
            continue
        games.append({"title": title, "igdb_id": igdb_id})
        print(f"  ✓ {title} (id: {igdb_id})")

    return games


def main():
    print("─" * 60)
    print("  MetaGuess — Linked Puzzle Generator")
    print("─" * 60)

    connection = input("\nConnection word (e.g. ISOLATION): ").strip().upper()
    if not connection:
        print("Connection word cannot be empty.")
        sys.exit(1)

    day_str = input("Day number: ").strip()
    try:
        day = int(day_str)
    except ValueError:
        print("Day must be a number.")
        sys.exit(1)

    games = prompt_games()

    print()
    model = load_vectors()
    word_ranks = rank_words(connection, model)
    print(f"  ✓ Ranked top {TOP_N:,} words\n")

    puzzle = {
        "day": day,
        "connection": connection,
        "games": games,
        "wordRanks": word_ranks
    }

    # Load or create database
    if OUTPUT_PATH.exists():
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            database = json.load(f)
    else:
        database = []

    # Replace if day already exists, otherwise append
    existing_days = [p["day"] for p in database]
    if day in existing_days:
        idx = existing_days.index(day)
        database[idx] = puzzle
        print(f"  ↺ Updated existing Day {day} entry")
    else:
        database.append(puzzle)
        database.sort(key=lambda p: p["day"])
        print(f"  ✓ Added Day {day} to database")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(database, f, ensure_ascii=False)

    print(f"  Saved to {OUTPUT_PATH}")

    # Preview top 10
    print(f"\n  Top 10 closest words to '{connection}':")
    top10 = sorted([(w, r) for w, r in word_ranks.items() if r <= 11], key=lambda x: x[1])
    for word, rank in top10:
        bar = "█" * (12 - rank)
        print(f"    #{rank:<4} {word:<20} {bar}")

    print("\n  Done! ✓")
    print("─" * 60)


if __name__ == "__main__":
    main()

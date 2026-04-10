import React, { useState, useEffect, useRef } from 'react';
import LINKED_DATABASE from './linked-database.json';
import GAMES_DATABASE from './games-database.json';
import { saveLinkedScore } from './Leaderboard';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTodayKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function getTodaysPuzzle() {
  const dateKey = getTodayKey();
  return LINKED_DATABASE.find(p => p.date === dateKey) || LINKED_DATABASE[0];
}

function getCoverUrl(igdb_id) {
  const game = GAMES_DATABASE.find(g => g.id === igdb_id);
  return game?.coverUrl ? `https:${game.coverUrl}` : null;
}

function getRankColor(rank) {
  if (rank <= 1)    return '#4ade80';
  if (rank <= 50)   return '#4ade80';
  if (rank <= 300)  return '#86efac';
  if (rank <= 800)  return '#fde047';
  if (rank <= 1500) return '#fb923c';
  return '#f87171';
}

const SUFFIXES = ['ing', 'tion', 'ness', 'ment', 'ies', 'es', 'ed', 'ly', 's'];

function normalize(word, wordRanks) {
  const w = word.toLowerCase().trim();
  if (wordRanks[w] !== undefined) return w;
  for (const suffix of SUFFIXES) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (stem.length > 2 && wordRanks[stem] !== undefined) return stem;
    }
  }
  return w;
}

function lookupRank(word, wordRanks) {
  const w = normalize(word, wordRanks);
  if (wordRanks[w] !== undefined) return wordRanks[w];
  for (const [k, v] of Object.entries(wordRanks)) {
    if (w.length > 3 && (k.startsWith(w) || w.startsWith(k))) {
      return Math.min(v + 15, 3000);
    }
  }
  return 3001;
}

function getHintWord(wordRanks, guesses) {
  const guessedWords = new Set(guesses.map(g => g.word.toLowerCase()));
  const bestRank = guesses.length > 0 ? Math.min(...guesses.map(g => g.rank)) : 3001;
  const candidates = Object.entries(wordRanks)
    .filter(([w, r]) => r > 1 && !guessedWords.has(w))
    .sort((a, b) => a[1] - b[1]);
  if (!candidates.length) return null;
  const target = Math.max(2, Math.floor(bestRank / 2));
  const betterThanBest = candidates.filter(([w, r]) => r < bestRank);
  const pool = betterThanBest.length > 0 ? betterThanBest : candidates;
  const closest = pool.reduce((best, cur) =>
    Math.abs(cur[1] - target) < Math.abs(best[1] - target) ? cur : best
  , pool[0]);
  return { word: closest[0], rank: closest[1] };
}

function getClosestWords(wordRanks, count = 100) {
  return Object.entries(wordRanks)
    .sort((a, b) => a[1] - b[1])
    .slice(1, count + 1)
    .map(([word, rank]) => ({ word, rank }));
}

function loadProgress(dateKey) {
  try {
    const saved = localStorage.getItem(`linked-progress-${dateKey}`);
    return saved ? JSON.parse(saved) : null;
  } catch { return null; }
}

function saveProgress(dateKey, guesses, solved, revealed) {
  try {
    localStorage.setItem(`linked-progress-${dateKey}`, JSON.stringify({ guesses, solved, revealed }));
  } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Linked({ onExit, user }) {
  const todayKey = getTodayKey();

  // Archive state — null means today
  const [selectedDate, setSelectedDate] = useState(null);

  const puzzle = selectedDate
    ? (LINKED_DATABASE.find(p => p.date === selectedDate) || getTodaysPuzzle())
    : getTodaysPuzzle();

  // Game state
  const [guesses, setGuesses] = useState([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [solved, setSolved] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [imgErrors, setImgErrors] = useState({});
  const [scoreSaved, setScoreSaved] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const inputRef = useRef(null);
  const activeDateRef = useRef(puzzle.date);

  // Progress map - tracks completion state per date so archive buttons don't read stale localStorage
  const [progressMap, setProgressMap] = useState(() => {
    const map = {};
    LINKED_DATABASE.forEach(p => {
      const saved = loadProgress(p.date);
      if (saved) map[p.date] = saved;
    });
    return map;
  });

  // Load saved progress whenever the active puzzle changes
  useEffect(() => {
    activeDateRef.current = puzzle.date;
    const saved = loadProgress(puzzle.date);
    if (saved) {
      setGuesses(saved.guesses || []);
      setSolved(saved.solved || false);
      setRevealed(saved.revealed || false);
    } else {
      setGuesses([]);
      setSolved(false);
      setRevealed(false);
    }
    setInput('');
    setError('');
    setImgErrors({});
    setScoreSaved(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [puzzle.date]);

  // Save progress - only fires on game state changes, uses ref for date
  // so it never runs with stale state when switching puzzles
  useEffect(() => {
    if (guesses.length > 0 || solved || revealed) {
      const dateKey = activeDateRef.current;
      saveProgress(dateKey, guesses, solved, revealed);
      setProgressMap(prev => ({ ...prev, [dateKey]: { guesses, solved, revealed } }));
    }
  }, [guesses, solved, revealed]);

  // Save score to Supabase when game ends
  useEffect(() => {
    if (!scoreSaved && (solved || revealed) && user) {
      saveLinkedScore(user.id, user.username, puzzle.date, solved, guesses.length);
      setScoreSaved(true);
    }
  }, [solved, revealed]);

  function handleImgError(igdb_id) {
    setImgErrors(prev => ({ ...prev, [igdb_id]: true }));
  }

  function submit() {
    const word = input.trim();
    setError('');
    if (!word || solved || revealed) return;
    if (guesses.find(g => g.word.toLowerCase() === word.toLowerCase())) {
      setError('already guessed that');
      return;
    }
    const rank = lookupRank(word, puzzle.wordRanks);
    setGuesses(prev => [{ word, rank }, ...prev]);
    setInput('');
    if (rank === 1 || word.toLowerCase() === puzzle.connection.toLowerCase()) {
      setSolved(true);
    }
  }

  function useHint() {
    const hint = getHintWord(puzzle.wordRanks, guesses);
    if (!hint) return;
    setGuesses(prev => [{ word: hint.word, rank: hint.rank, isHint: true }, ...prev]);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') submit();
  }

  const done = solved || revealed;
  const sortedGuesses = [...guesses].sort((a, b) => a.rank - b.rank);
  const hintsUsed = guesses.filter(g => g.isHint).length;
  const closestWords = getClosestWords(puzzle.wordRanks, 100);

  // Past puzzles for archive picker — all dates up to and including today, newest first
  const pastPuzzles = [...LINKED_DATABASE]
    .filter(p => p.date <= todayKey)
    .sort((a, b) => b.date.localeCompare(a.date));

  const activeDateKey = selectedDate || todayKey;

  return (
    <div className="min-h-screen ps2-bg text-white flex flex-col">

      {/* Scanlines */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1,
        background: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px)'
      }} />

      {/* Header */}
      <div className="ps2-header w-full px-4 py-4 mb-4 relative z-40">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <button
            onClick={onExit}
            className="text-blue-400 hover:text-blue-200 transition-colors text-sm flex items-center gap-2"
            style={{ fontFamily: 'monospace' }}
          >
            ← EXIT
          </button>
          <h1 className="ps2-title text-xl sm:text-2xl font-extrabold tracking-tight">
            LINKED
          </h1>
          <div style={{ fontFamily: 'monospace', fontSize: '10px', color: '#374151', letterSpacing: '1px' }}>
            {guesses.length} GUESS{guesses.length !== 1 ? 'ES' : ''}
          </div>
        </div>
      </div>

      {/* Archive Banner */}
      {pastPuzzles.length > 1 && (
        <div className="relative z-10 px-4 mb-4">
          <div className="max-w-lg mx-auto">
            <button
              onClick={() => setCalendarOpen(o => !o)}
              style={{
                width: '100%', fontFamily: 'monospace', cursor: 'pointer',
                background: calendarOpen ? '#0f172a' : '#080818',
                border: calendarOpen ? '1px solid #1e3a8a' : '1px solid #13132a',
                borderRadius: '10px', padding: '10px 16px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                transition: 'all 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#3b82f6', fontWeight: 700 }}>PLAY ARCHIVE</div>
                  <div style={{ fontSize: '9px', letterSpacing: '1px', color: '#374151', marginTop: '1px' }}>
                    {pastPuzzles.filter(p => progressMap[p.date]?.solved).length} / {pastPuzzles.length} COMPLETED
                  </div>
                </div>
              </div>
              <span style={{ color: '#1e3a8a', fontSize: '12px' }}>{calendarOpen ? '▲' : '▼'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Calendar Archive Modal */}
      {calendarOpen && pastPuzzles.length > 0 && (() => {
        const { year, month } = calendarMonth;
        const monthName = new Date(year, month).toLocaleString('default', { month: 'long' });
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const puzzleDates = new Set(pastPuzzles.map(p => p.date));
        const DAY_LABELS = ['S','M','T','W','T','F','S'];

        const earliest = pastPuzzles[pastPuzzles.length - 1].date; // sorted newest first
        const [eYear, eMonth] = earliest.split('-').map(Number);
        const prevMonth = () => setCalendarMonth(({ year, month }) => {
          const isAtEarliest = year === eYear && month === eMonth - 1;
          if (isAtEarliest) return { year, month };
          if (month === 0) return { year: year - 1, month: 11 };
          return { year, month: month - 1 };
        });
        const today = new Date();
        const [tYear, tMonth] = [today.getFullYear(), today.getMonth()];
        const nextMonth = () => setCalendarMonth(({ year, month }) => {
          const isAtToday = year === tYear && month === tMonth;
          if (isAtToday) return { year, month };
          if (month === 11) return { year: year + 1, month: 0 };
          return { year, month: month + 1 };
        });

        const cells = [];
        for (let i = 0; i < firstDay; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) cells.push(d);

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.7)' }}
            onClick={() => setCalendarOpen(false)}
          >
            <div
              style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', borderRadius: '16px', padding: '20px', width: '100%', maxWidth: '340px' }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <span style={{ fontFamily: 'monospace', fontSize: '9px', letterSpacing: '3px', color: '#4b5563' }}>ARCHIVE</span>
                <button onClick={() => setCalendarOpen(false)} style={{ background: 'none', border: 'none', color: '#3b5bdb', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}>✕</button>
              </div>
                {/* Month nav */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <button onClick={prevMonth} disabled={year === eYear && month === eMonth - 1} style={{ background: 'none', border: 'none', color: (year === eYear && month === eMonth - 1) ? '#1f2937' : '#3b5bdb', cursor: (year === eYear && month === eMonth - 1) ? 'default' : 'pointer', fontFamily: 'monospace', fontSize: '14px', padding: '0 6px' }}>‹</button>
                  <span style={{ fontFamily: 'monospace', fontSize: '10px', letterSpacing: '3px', color: '#4b5563', textTransform: 'uppercase' }}>
                    {monthName} {year}
                  </span>
                  <button onClick={nextMonth} disabled={year === tYear && month === tMonth} style={{ background: 'none', border: 'none', color: (year === tYear && month === tMonth) ? '#1f2937' : '#3b5bdb', cursor: (year === tYear && month === tMonth) ? 'default' : 'pointer', fontFamily: 'monospace', fontSize: '14px', padding: '0 6px' }}>›</button>
                </div>

                {/* Day labels */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '3px', marginBottom: '4px' }}>
                  {DAY_LABELS.map((d, i) => (
                    <div key={i} style={{ textAlign: 'center', fontFamily: 'monospace', fontSize: '8px', color: '#374151', letterSpacing: '1px', padding: '2px 0' }}>{d}</div>
                  ))}
                </div>

                {/* Day cells */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '3px' }}>
                  {cells.map((day, i) => {
                    if (!day) return <div key={`empty-${i}`} />;
                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const hasPuzzle = puzzleDates.has(dateStr);
                    const isFuture = dateStr > todayKey;
                    const isToday = dateStr === todayKey;
                    const isActive = dateStr === activeDateKey;
                    const progress = progressMap[dateStr];
                    const wasSolved = progress?.solved;
                    const wasPlayed = progress && (progress.guesses?.length > 0 || progress.solved || progress.revealed);
                    const isClickable = hasPuzzle && !isFuture;

                    let bg = 'transparent';
                    let color = '#1f2937';
                    let border = '1px solid transparent';
                    let fontWeight = 400;

                    if (isActive) { bg = '#2563eb'; color = '#fff'; border = '1px solid #3b82f6'; fontWeight = 700; }
                    else if (wasSolved) { bg = '#052e16'; color = '#4ade80'; border = '1px solid #166534'; }
                    else if (wasPlayed) { bg = '#18181b'; color = '#71717a'; border = '1px solid #3f3f46'; }
                    else if (isToday) { bg = '#0f172a'; color = '#60a5fa'; border = '1px solid #1e3a8a'; fontWeight = 700; }
                    else if (hasPuzzle) { bg = '#0d0d1a'; color = '#3b5bdb'; border = '1px solid #1e1b4b'; }

                    return (
                      <button
                        key={dateStr}
                        disabled={!isClickable}
                        onClick={() => {
                          setSelectedDate(isToday ? null : dateStr);
                          setCalendarOpen(false);
                        }}
                        style={{
                          background: bg, color, border, borderRadius: '6px',
                          fontFamily: 'monospace', fontSize: '11px', fontWeight,
                          padding: '5px 0', textAlign: 'center',
                          cursor: isClickable ? 'pointer' : 'default',
                          transition: 'all 0.15s',
                          opacity: isFuture ? 0.15 : !hasPuzzle ? 0.2 : 1,
                        }}
                      >
                        {day}
                        {wasSolved && <div style={{ width: '3px', height: '3px', borderRadius: '50%', background: '#4ade80', margin: '1px auto 0' }} />}
                      </button>
                    );
                  })}
                </div>

                {/* Legend */}
                <div style={{ display: 'flex', gap: '12px', marginTop: '12px', justifyContent: 'center' }}>
                  {[
                    { color: '#4ade80', label: 'solved' },
                    { color: '#71717a', label: 'played' },
                    { color: '#3b5bdb', label: 'available' },
                  ].map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: color }} />
                      <span style={{ fontFamily: 'monospace', fontSize: '8px', color: '#374151', letterSpacing: '1px' }}>{label}</span>
                    </div>
                  ))}
                </div>
            </div>
          </div>
        );
      })()}

      {/* Body */}
      <div className="flex-1 relative z-10 px-4 pb-8">
        <div className="max-w-lg mx-auto flex flex-col gap-5">

          {/* Prompt */}
          <div style={{
            fontFamily: 'monospace', fontSize: '10px', letterSpacing: '3px',
            color: '#4b5563', textAlign: 'center', textTransform: 'uppercase'
          }}>
            WHAT CONNECTS THESE GAMES?
          </div>

          {/* Game Covers */}
          <div className="flex gap-4 justify-center">
            {puzzle.games.map((game) => {
              const coverUrl = getCoverUrl(game.igdb_id);
              const hasError = imgErrors[game.igdb_id];
              return (
                <div key={game.igdb_id} style={{
                  flex: 1, maxWidth: '160px', aspectRatio: '3/4',
                  borderRadius: '8px', overflow: 'hidden',
                  border: solved ? '1.5px solid #22c55e' : '1.5px solid #252550',
                  boxShadow: solved ? '0 0 16px rgba(34,197,94,0.25)' : 'none',
                  transition: 'border-color 0.4s, box-shadow 0.4s',
                  position: 'relative', background: '#0f0f24',
                }}>
                  {coverUrl && !hasError ? (
                    <img
                      src={coverUrl}
                      alt={game.title}
                      title={game.title}
                      onError={() => handleImgError(game.igdb_id)}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', filter: 'brightness(0.9)' }}
                    />
                  ) : (
                    <div style={{
                      width: '100%', height: '100%', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                      padding: '8px', textAlign: 'center',
                      fontFamily: 'monospace', fontSize: '10px', color: '#374151'
                    }}>
                      {game.title}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Win Banner */}
          {solved && (
            <div style={{
              background: '#041a0c', border: '1.5px solid #22c55e',
              borderRadius: '10px', padding: '16px', textAlign: 'center',
              animation: 'linkedPop 0.35s cubic-bezier(0.34,1.56,0.64,1)'
            }}>
              <div style={{ fontFamily: 'monospace', fontSize: '9px', color: '#4b5563', letterSpacing: '2px', marginBottom: '6px' }}>
                CONNECTION
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '24px', fontWeight: 900, color: '#4ade80', letterSpacing: '3px', marginBottom: '4px' }}>
                {puzzle.connection}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '9px', color: '#4b5563' }}>
                found in {guesses.length} guess{guesses.length !== 1 ? 'es' : ''}
                {hintsUsed > 0 ? ` · ${hintsUsed} hint${hintsUsed !== 1 ? 's' : ''} used` : ''}
              </div>
            </div>
          )}

          {/* Give Up Banner */}
          {revealed && !solved && (
            <div style={{
              background: '#120408', border: '1.5px solid #4b1028',
              borderRadius: '10px', padding: '16px', textAlign: 'center'
            }}>
              <div style={{ fontFamily: 'monospace', fontSize: '9px', color: '#4b5563', letterSpacing: '2px', marginBottom: '6px' }}>
                THE CONNECTION WAS
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '24px', fontWeight: 900, color: '#f87171', letterSpacing: '3px' }}>
                {puzzle.connection}
              </div>
            </div>
          )}

          {/* 100 Closest Words dropdown (post-game) */}
          {done && (
            <details style={{ background: '#0c0c1e', borderRadius: '8px', border: '1px solid #1a1a30' }}>
              <summary style={{
                fontFamily: 'monospace', fontSize: '9px', color: '#4b5563',
                letterSpacing: '1px', padding: '10px 12px', cursor: 'pointer',
                listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}>
                <span>100 CLOSEST WORDS</span>
                <span>▾</span>
              </summary>
              <div style={{
                maxHeight: '280px', overflowY: 'auto',
                display: 'flex', flexDirection: 'column', gap: '2px',
                padding: '0 8px 8px',
              }}>
                {closestWords.map(({ word, rank }) => (
                  <div key={word} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '5px 8px', borderRadius: '4px', background: '#141428',
                    borderLeft: `2px solid ${getRankColor(rank)}55`,
                  }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '11px', color: '#9ca3af' }}>{word}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: '10px', color: getRankColor(rank) }}>#{rank}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Instructions — hidden after first guess */}
          {guesses.length === 0 && !done && (
            <div style={{
              fontFamily: 'monospace', fontSize: '10px', color: '#9ca3af',
              textAlign: 'center', lineHeight: 1.8, letterSpacing: '0.5px'
            }}>
              Three games. One hidden word that connects them all. Type your best guess, you'll see how close you are ranked against every word in the dictionary.
              <br />
              The closer to #1, the warmer you are.
            </div>
          )}

          {/* Input */}
          {!done && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  className="ps2-input flex-1 rounded-lg px-4 py-2.5 text-sm text-blue-100 placeholder-blue-900"
                  placeholder="guess the connection..."
                  value={input}
                  onChange={e => { setInput(e.target.value); setError(''); }}
                  onKeyDown={handleKeyDown}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button
                  className="ps2-btn text-white rounded-lg px-4 py-2.5 text-xs"
                  style={{ fontFamily: 'monospace', letterSpacing: '1px', whiteSpace: 'nowrap' }}
                  onClick={submit}
                >
                  GUESS
                </button>
              </div>
              {error && (
                <div style={{ fontFamily: 'monospace', fontSize: '9px', color: '#f87171', textAlign: 'center' }}>
                  {error}
                </div>
              )}
            </div>
          )}

          {/* Hint + Give Up — appears after 5 guesses */}
          {!done && guesses.length >= 5 && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={useHint}
                style={{
                  flex: 1, background: 'transparent',
                  border: '1px solid #2d2d5e', borderRadius: '6px',
                  color: '#7c3aed', fontSize: '9px', fontFamily: 'monospace',
                  padding: '6px 14px', cursor: 'pointer', letterSpacing: '1px', transition: 'all 0.2s'
                }}
              >
                HINT{hintsUsed > 0 ? ` (${hintsUsed})` : ''}
              </button>
              <button
                onClick={() => setRevealed(true)}
                style={{
                  flex: 1, background: 'transparent',
                  border: '1px solid #1e1e3a', borderRadius: '6px',
                  color: '#374151', fontSize: '9px', fontFamily: 'monospace',
                  padding: '6px 14px', cursor: 'pointer', letterSpacing: '1px', transition: 'all 0.2s'
                }}
              >
                GIVE UP
              </button>
            </div>
          )}

          {/* Guess History */}
          {guesses.length > 0 && (
            <div className="flex flex-col gap-1">
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontFamily: 'monospace', fontSize: '9px', color: '#374151',
                letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px'
              }}>
                <span>GUESSES</span>
                <span style={{ color: '#4b5563' }}>{guesses.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '260px', overflowY: 'auto' }}>
                {sortedGuesses.map((g, i) => {
                  const color = getRankColor(g.rank);
                  const pct = g.rank === 1 ? 100 : Math.max(2, Math.round((3001 - g.rank) / 3001 * 100));
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: '10px',
                      padding: '6px 10px',
                      background: g.isHint ? '#0d0d24' : '#0c0c1e',
                      borderRadius: '5px',
                      border: g.isHint ? '1px solid #2d2d5e' : '1px solid #1a1a30',
                    }}>
                      <span style={{
                        fontFamily: 'monospace', fontSize: '11px',
                        color: g.isHint ? '#7c3aed' : '#9ca3af',
                        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                      }}>
                        {g.word}
                      </span>
                      <div style={{ width: '80px', background: '#1a1a30', borderRadius: '2px', height: '4px', flexShrink: 0 }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '2px', transition: 'width 0.5s ease' }} />
                      </div>
                      <span style={{ fontFamily: 'monospace', fontSize: '10px', color, minWidth: '44px', textAlign: 'right', flexShrink: 0 }}>
                        {`#${g.rank.toLocaleString()}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      </div>

      <style>{`
        @keyframes linkedPop {
          from { opacity: 0; transform: scale(0.92); }
          to   { opacity: 1; transform: scale(1); }
        }
        details summary::-webkit-details-marker { display: none; }
      `}</style>
    </div>
  );
}

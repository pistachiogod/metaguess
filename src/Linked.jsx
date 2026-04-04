import React, { useState, useEffect, useRef } from 'react';
import LINKED_DATABASE from './linked-database.json';
import GAMES_DATABASE from './games-database.json';

// ── Helpers ──────────────────────────────────────────────────────────────────

const EPOCH = new Date('2025-01-01');

function getTodaysPuzzle() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysSinceEpoch = Math.floor((today - EPOCH) / (1000 * 60 * 60 * 24));
  const idx = daysSinceEpoch % LINKED_DATABASE.length;
  return LINKED_DATABASE[idx];
}

function getCoverUrl(igdb_id) {
  const game = GAMES_DATABASE.find(g => g.id === igdb_id);
  return game?.coverUrl ? `https:${game.coverUrl}` : null;
}

function getRankColor(rank) {
  if (rank === 1)    return '#4ade80';
  if (rank <= 50)    return '#4ade80';
  if (rank <= 300)   return '#86efac';
  if (rank <= 800)   return '#fde047';
  if (rank <= 1500)  return '#fb923c';
  return '#f87171';
}

function getRankLabel(rank) {
  if (rank === 1)    return 'SOLVED';
  if (rank <= 50)    return `#${rank}`;
  if (rank <= 300)   return `#${rank}`;
  if (rank <= 800)   return `#${rank}`;
  if (rank <= 1500)  return `#${rank}`;
  return `#${rank}`;
}

function lookupRank(word, wordRanks) {
  const w = word.toLowerCase().trim();
  if (wordRanks[w] !== undefined) return wordRanks[w];
  // Partial prefix match as fallback
  for (const [k, v] of Object.entries(wordRanks)) {
    if (w.length > 3 && (k.startsWith(w) || w.startsWith(k))) {
      return Math.min(wordRanks[k] + 15, 3000);
    }
  }
  return 3001; // unknown — very cold
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Linked({ onExit }) {
  const puzzle = getTodaysPuzzle();
  const [guesses, setGuesses] = useState([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [solved, setSolved] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [imgErrors, setImgErrors] = useState({});
  const inputRef = useRef(null);
  const historyRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
    const newGuess = { word, rank };
    const newGuesses = [newGuess, ...guesses];
    setGuesses(newGuesses);
    setInput('');

    if (rank === 1 || word.toLowerCase() === puzzle.connection.toLowerCase()) {
      setSolved(true);
    }

    setTimeout(() => {
      historyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }, 50);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') submit();
  }

  const done = solved || revealed;

  // Sort guesses by rank for display
  const sortedGuesses = [...guesses].sort((a, b) => a.rank - b.rank);

  return (
    <div className="min-h-screen ps2-bg text-white flex flex-col">

      {/* Scanlines */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1,
        background: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px)'
      }} />

      {/* Header */}
      <div className="ps2-header w-full px-4 py-4 mb-6 relative z-40">
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
          <div style={{
            fontFamily: 'monospace', fontSize: '10px',
            color: '#374151', letterSpacing: '1px'
          }}>
            {guesses.length} GUESS{guesses.length !== 1 ? 'ES' : ''}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 relative z-10 px-4 pb-8">
        <div className="max-w-lg mx-auto flex flex-col gap-6">

          {/* Prompt */}
          <div style={{
            fontFamily: 'monospace', fontSize: '10px', letterSpacing: '3px',
            color: '#4b5563', textAlign: 'center', textTransform: 'uppercase'
          }}>
            WHAT CONNECTS THESE GAMES?
          </div>

          {/* Game Covers */}
          <div className="flex gap-4 justify-center">
            {puzzle.games.map((game, i) => {
              const coverUrl = getCoverUrl(game.igdb_id);
              const hasError = imgErrors[game.igdb_id];
              return (
                <div
                  key={game.igdb_id}
                  style={{
                    flex: 1, maxWidth: '160px',
                    aspectRatio: '3/4',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: solved ? '1.5px solid #22c55e' : '1.5px solid #252550',
                    boxShadow: solved ? '0 0 16px rgba(34,197,94,0.25)' : 'none',
                    transition: 'border-color 0.4s, box-shadow 0.4s',
                    position: 'relative',
                    background: '#0f0f24',
                  }}
                >
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
                      width: '100%', height: '100%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '8px', textAlign: 'center',
                      fontFamily: 'monospace', fontSize: '9px',
                      color: '#374151', lineHeight: 1.4
                    }}>
                      {game.title}
                    </div>
                  )}
                  {/* Gloss overlay */}
                  <div style={{
                    position: 'absolute', inset: 0, pointerEvents: 'none',
                    background: 'linear-gradient(135deg, rgba(124,58,237,0.06) 0%, transparent 50%)'
                  }} />
                </div>
              );
            })}
          </div>

          {/* Win / Reveal Banner */}
          {solved && (
            <div style={{
              background: '#041a0c', border: '1.5px solid #22c55e',
              borderRadius: '10px', padding: '16px', textAlign: 'center',
              animation: 'linkedPop 0.35s cubic-bezier(0.34,1.56,0.64,1)'
            }}>
              <div style={{ fontFamily: 'monospace', fontSize: '9px', color: '#4b5563', letterSpacing: '2px', marginBottom: '6px' }}>
                CONNECTION
              </div>
              <div style={{
                fontFamily: 'monospace', fontSize: '24px', fontWeight: 900,
                color: '#4ade80', letterSpacing: '3px', marginBottom: '4px'
              }}>
                {puzzle.connection}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '9px', color: '#4b5563' }}>
                found in {guesses.length} guess{guesses.length !== 1 ? 'es' : ''}
              </div>
            </div>
          )}

          {revealed && !solved && (
            <div style={{
              background: '#120408', border: '1.5px solid #4b1028',
              borderRadius: '10px', padding: '16px', textAlign: 'center'
            }}>
              <div style={{ fontFamily: 'monospace', fontSize: '9px', color: '#4b5563', letterSpacing: '2px', marginBottom: '6px' }}>
                THE CONNECTION WAS
              </div>
              <div style={{
                fontFamily: 'monospace', fontSize: '24px', fontWeight: 900,
                color: '#f87171', letterSpacing: '3px'
              }}>
                {puzzle.connection}
              </div>
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

          {/* Give up */}
          {!done && guesses.length >= 5 && (
            <button
              onClick={() => setRevealed(true)}
              style={{
                background: 'transparent', border: '1px solid #1e1e3a',
                borderRadius: '6px', color: '#374151', fontSize: '9px',
                fontFamily: 'monospace', padding: '6px 14px', cursor: 'pointer',
                width: '100%', transition: 'all 0.2s'
              }}
              onMouseEnter={e => { e.target.style.borderColor = '#4b5563'; e.target.style.color = '#6b7280'; }}
              onMouseLeave={e => { e.target.style.borderColor = '#1e1e3a'; e.target.style.color = '#374151'; }}
            >
              give up
            </button>
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
              <div
                ref={historyRef}
                style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '260px', overflowY: 'auto' }}
              >
                {sortedGuesses.map((g, i) => {
                  const color = getRankColor(g.rank);
                  const pct = g.rank === 1 ? 100 : Math.max(2, Math.round((3001 - g.rank) / 3001 * 100));
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '6px 10px', background: '#0c0c1e',
                        borderRadius: '5px', border: '1px solid #1a1a30',
                      }}
                    >
                      <span style={{ fontFamily: 'monospace', fontSize: '11px', color: '#9ca3af', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {g.word}
                      </span>
                      <div style={{ width: '80px', background: '#1a1a30', borderRadius: '2px', height: '4px', flexShrink: 0 }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '2px', transition: 'width 0.5s ease' }} />
                      </div>
                      <span style={{ fontFamily: 'monospace', fontSize: '10px', color, minWidth: '44px', textAlign: 'right', flexShrink: 0 }}>
                        {g.rank === 1 ? '🏆' : `#${g.rank.toLocaleString()}`}
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
      `}</style>
    </div>
  );
}

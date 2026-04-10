import React, { useState, useEffect, useMemo, useRef } from 'react';
import GAMES_DATABASE from './games-database.json';
import WhichCameFirst from './WhichCameFirst.jsx';
import Linked from './Linked.jsx';
import { Analytics } from '@vercel/analytics/react';
import { useAuth, saveScore, fetchCloudStats, checkTodayPlayed, LoginModal, LeaderboardModal } from './Leaderboard';

// Seeded random number generator for daily puzzles
const seededRandom = (seed) => {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
};

// 🔧 DEV OVERRIDE: set to an igdb_id to force today's game, or null for normal selection
const DAILY_GAME_OVERRIDE = null; // Breath of the Wild (change ID as needed)

// Get today's date key for localStorage
const getTodayKey = () => {
  const today = new Date();
  return `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
};

// Get date key for any date
const getDateKey = (date) => {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

// Game pools by difficulty tier
const POPULAR_GAMES = GAMES_DATABASE.filter(g => g.popularityRank <= 300);
const ALL_GAMES = GAMES_DATABASE;

// Pick a game for a given date: 70% popular, 30% any, no repeats within 45 days
const getGameForSeed = (seed, recentGameIds) => {
  const rand1 = seededRandom(seed);
  const rand2 = seededRandom(seed + 1);
  const pool = rand1 < 0.7 ? POPULAR_GAMES : ALL_GAMES;
  
  // Try to find a game not in recent history
  let index = Math.floor(rand2 * pool.length);
  let game = pool[index];
  
  // If it's a repeat, walk forward through the pool until we find a fresh one
  if (recentGameIds.has(game.id)) {
    for (let i = 1; i < pool.length; i++) {
      const candidate = pool[(index + i) % pool.length];
      if (!recentGameIds.has(candidate.id)) {
        game = candidate;
        break;
      }
    }
  }
  return game;
};

// Build set of recently used game IDs (last 45 days before the given date)
const getRecentGameIds = (targetDate) => {
  const recent = new Set();
  for (let i = 1; i <= 45; i++) {
    const pastDate = new Date(targetDate);
    pastDate.setDate(pastDate.getDate() - i);
    const pastSeed = pastDate.getFullYear() * 10000 + (pastDate.getMonth() + 1) * 100 + pastDate.getDate();
    const rand1 = seededRandom(pastSeed);
    const rand2 = seededRandom(pastSeed + 1);
    const pool = rand1 < 0.7 ? POPULAR_GAMES : ALL_GAMES;
    const index = Math.floor(rand2 * pool.length);
    recent.add(pool[index].id);
  }
  return recent;
};

// Get today's game
const getTodaysGame = () => {
  // DEV OVERRIDE
  if (DAILY_GAME_OVERRIDE !== null) {
    const overrideGame = GAMES_DATABASE.find(g => g.igdb_id === DAILY_GAME_OVERRIDE);
    if (overrideGame) return overrideGame;
  }
  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  const recentIds = getRecentGameIds(today);
  return getGameForSeed(seed, recentIds);
};

// Get game number (days since launch)
const getGameNumber = () => {
  return Math.floor((new Date() - new Date('2026-02-10')) / (1000 * 60 * 60 * 24)) + 1;
};

// Load stats from localStorage
const loadStats = () => {
  try {
    const saved = localStorage.getItem('metaguess-stats');
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return {
    gamesPlayed: 0,
    gamesWon: 0,
    currentStreak: 0,
    maxStreak: 0,
    guessDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 },
    lastPlayedDate: null,
    lastGameNumber: null,
  };
};

const saveStats = (stats) => {
  try { localStorage.setItem('metaguess-stats', JSON.stringify(stats)); } catch (e) {}
};

// Load today's game state from localStorage
const loadTodayState = () => {
  try {
    const saved = localStorage.getItem('metaguess-today');
    if (saved) {
      const state = JSON.parse(saved);
      if (state.dateKey === getTodayKey()) return state;
    }
  } catch (e) {}
  return null;
};

const saveTodayState = (guesses, gameWon, gameOver) => {
  try {
    localStorage.setItem('metaguess-today', JSON.stringify({
      dateKey: getTodayKey(), guesses, gameWon, gameOver,
    }));
  } catch (e) {}
};

// --- History tracking for memory card ---
const loadHistory = () => {
  try {
    const saved = localStorage.getItem('metaguess-history');
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return {};
};

const saveToHistory = (dateKey, gameId, won, numGuesses) => {
  try {
    const history = loadHistory();
    history[dateKey] = { gameId, won, numGuesses, completedAt: Date.now() };
    localStorage.setItem('metaguess-history', JSON.stringify(history));
  } catch (e) {}
};

// Compare two values and return feedback
// Platform family grouping for yellow/partial matches
const PLATFORM_FAMILIES = {
  'PlayStation': ['PlayStation', 'PlayStation 2', 'PlayStation 3', 'PlayStation 4', 'PlayStation 5', 'PSP', 'PS Vita'],
  'Nintendo': ['NES', 'SNES', 'Nintendo 64', 'GameCube', 'Wii', 'Wii U', 'Nintendo Switch', 'Nintendo Switch 2', 'Game Boy', 'Game Boy Color', 'Game Boy Advance', 'Nintendo DS', 'Nintendo 3DS'],
  'Xbox': ['Xbox', 'Xbox 360', 'Xbox One', 'Xbox Series X|S'],
  'Sega': ['Genesis', 'Game Gear', 'Sega 32X', 'Sega CD', 'Sega Saturn', 'Dreamcast'],
};
const getPlatformFamily = (platform) => {
  for (const [family, members] of Object.entries(PLATFORM_FAMILIES)) {
    if (members.includes(platform)) return family;
  }
  return platform; // PC, Arcade, Multi-platform, Other return themselves
};

const compareValues = (guess, target, type) => {
  if (type === 'exact') {
    if (guess === target) return 'correct';
    if (guess === 'Unknown' || target === 'Unknown') return 'unknown';
    return 'wrong';
  }
  if (type === 'platform') {
    if (guess === target) return 'correct';
    if (guess === 'Unknown' || target === 'Unknown') return 'unknown';
    const guessFamily = getPlatformFamily(guess);
    const targetFamily = getPlatformFamily(target);
    if (guessFamily === targetFamily) return 'partial';
    return 'wrong';
  }
  if (type === 'number') {
    if (guess === target) return 'correct';
    if (guess === null || target === null) return 'unknown';
    return guess < target ? 'higher' : 'lower';
  }
  if (type === 'year') {
    if (guess === target) return 'correct';
    if (guess === null || target === null) return 'unknown';
    if (Math.abs(guess - target) <= 5) return guess < target ? 'partial_higher' : 'partial_lower';
    return guess < target ? 'higher' : 'lower';
  }
  if (type === 'rank') {
    if (guess === target) return 'correct';
    if (guess === null || target === null) return 'unknown';
    if (Math.abs(guess - target) <= 30) return guess > target ? 'partial_higher' : 'partial_lower';
    return guess > target ? 'higher' : 'lower';
  }
  if (type === 'array') {
    if (!guess?.length || !target?.length) return 'unknown';
    const guessSet = new Set(guess.map(g => g.toLowerCase()));
    const targetSet = new Set(target.map(t => t.toLowerCase()));
    const overlap = [...guessSet].filter(g => targetSet.has(g));
    if (overlap.length === targetSet.size && guessSet.size === targetSet.size) return 'correct';
    if (overlap.length > 0) return 'partial';
    return 'wrong';
  }
  if (type === 'boolean') {
    return guess === target ? 'correct' : 'wrong';
  }
  return 'wrong';
};

// Helper: reconstruct guesses from saved IDs against a target game
const reconstructGuesses = (guessIds, tGame) => {
  return guessIds.map(guessId => {
    const game = GAMES_DATABASE.find(g => g.id === guessId);
    if (!game) return null;
    return {
      ...game,
      feedback: {
        name: game.id === tGame.id ? 'correct' : 'wrong',
        year: compareValues(game.year, tGame.year, 'year'),
        artStyle: compareValues(game.artStyle, tGame.artStyle, 'exact'),
        platform: compareValues(game.platform, tGame.platform, 'platform'),
        protagonistType: compareValues(game.protagonistType, tGame.protagonistType, 'exact'),
        protagonistGender: compareValues(game.protagonistGender, tGame.protagonistGender, 'exact'),
        setting: compareValues(game.setting, tGame.setting, 'exact'),
        primaryGenre: compareValues(game.primaryGenre, tGame.primaryGenre, 'exact'),
        genres: compareValues(game.genres?.slice(0, 3), tGame.genres?.slice(0, 3), 'array'),
        publisher: compareValues(game.publisher, tGame.publisher, 'exact'),
        isMultiplayer: compareValues(game.isMultiplayer, tGame.isMultiplayer, 'boolean'),
        perspective: compareValues(game.perspective, tGame.perspective, 'exact'),
        franchise: (game.franchise === null && tGame.franchise === null) ? 'correct' : (game.franchise && tGame.franchise) ? compareValues(game.franchise, tGame.franchise, 'exact') : 'wrong',
        rating: compareValues(game.popularityRank, tGame.popularityRank, 'rank'),
      }
    };
  }).filter(Boolean);
};

// Get game for a specific date
const getGameForDate = (date) => {
  const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  const recentIds = getRecentGameIds(date);
  return getGameForSeed(seed, recentIds);
};

// ============================================
// Memory Card Screen Component
// ============================================
function MemoryCardScreen({ onClose, onPlayGame }) {
  const [hoveredSlot, setHoveredSlot] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  const history = loadHistory();

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const cols = isMobile ? 3 : 5;
  const totalSlots = isMobile ? 12 : 15;

  // Generate past days (NOT including today)
  const slots = [];
  for (let i = 1; i <= totalSlots; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateKey = getDateKey(date);
    const game = getGameForDate(date);
    const completed = history[dateKey];
    slots.push({ date, dateKey, game, completed });
  }

  const activeSlot = hoveredSlot !== null ? slots[hoveredSlot] : selectedSlot !== null ? slots[selectedSlot] : null;

  const handleSlotClick = (slot, idx) => {
    onPlayGame(slot.game, slot.dateKey);
  };

  // Per-slot variation
  const slotVariations = useMemo(() => {
    return slots.map((_, idx) => {
      const s1 = Math.sin(idx * 7.3 + 1.1) * 0.5 + 0.5;
      const s2 = Math.sin(idx * 13.7 + 2.3) * 0.5 + 0.5;
      const s3 = Math.sin(idx * 3.1 + 5.7) * 0.5 + 0.5;
      const s4 = Math.sin(idx * 11.3 + 0.7) * 0.5 + 0.5;
      const scale = isMobile ? 0.5 : 1;
      return {
        rotateY: -25 + s1 * 20,
        rotateX: 5 + s2 * (isMobile ? 8 : 15),
        rotateZ: (-3 + s3 * 6) * scale,
        translateZ: (-20 + s4 * 40) * scale,
        offsetX: (s1 - 0.5) * 10 * scale,
        offsetY: (s2 - 0.5) * 8 * scale,
      };
    });
  }, [slots.length, isMobile]);

  // 3D Game Case component
  const GameCase3D = ({ coverUrl, alt, isHovered, won, numGuesses, variation }) => {
    const depth = isMobile ? 6 : 12;
    const v = variation;

    return (
      <div
        className="game-case-3d"
        style={{
          width: '100%',
          height: '100%',
          transformStyle: 'preserve-3d',
          transition: 'transform 0.35s cubic-bezier(0.23, 1, 0.32, 1)',
          transform: isHovered
            ? `translateZ(${isMobile ? 20 : 60}px) translateY(-${isMobile ? 4 : 12}px) rotateY(-5deg) rotateX(2deg) rotateZ(0deg) scale(${isMobile ? 1.04 : 1.1})`
            : `translateZ(${v.translateZ}px) translateX(${v.offsetX}px) translateY(${v.offsetY}px) rotateY(${v.rotateY}deg) rotateX(${v.rotateX}deg) rotateZ(${v.rotateZ}deg)`,
        }}
      >
        {/* Front face */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `translateZ(${depth / 2}px)`,
            borderRadius: '3px',
            overflow: 'hidden',
            boxShadow: isHovered 
              ? '0 16px 40px rgba(0,0,0,0.5), 0 0 20px rgba(0,0,0,0.3)'
              : '0 4px 12px rgba(0,0,0,0.3)',
            transition: 'box-shadow 0.35s ease',
          }}
        >
          <img
            src={`https:${coverUrl}`}
            alt={alt}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              filter: isHovered ? 'brightness(1.2) saturate(1.1)' : 'brightness(0.8)',
              transition: 'filter 0.35s ease',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: isHovered
                ? 'linear-gradient(135deg, rgba(255,255,255,0.2) 0%, transparent 40%)'
                : 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, transparent 50%)',
              transition: 'background 0.35s ease',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Back face */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `translateZ(${-depth / 2}px) rotateY(180deg)`,
            background: 'linear-gradient(180deg, #1a1a30 0%, #111125 100%)',
            borderRadius: '3px',
          }}
        />

        {/* Left spine */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${depth}px`,
            height: '100%',
            transform: `rotateY(-90deg) translateZ(0px) translateX(${-depth / 2}px)`,
            background: 'linear-gradient(180deg, #3a3a5a 0%, #222240 30%, #1a1a35 100%)',
            borderRadius: '2px 0 0 2px',
          }}
        >
          <div style={{
            position: 'absolute',
            right: 0,
            top: '8%',
            bottom: '8%',
            width: '1px',
            background: 'rgba(255,255,255,0.1)',
          }} />
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '2px',
            background: 'rgba(0,0,0,0.3)',
          }} />
        </div>

        {/* Right edge */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: `${depth}px`,
            height: '100%',
            transform: `rotateY(90deg) translateZ(0px) translateX(${depth / 2}px)`,
            background: 'linear-gradient(180deg, #1a1a30 0%, #111125 100%)',
          }}
        />

        {/* Top edge */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${depth}px`,
            transform: `rotateX(90deg) translateZ(0px) translateY(${-depth / 2}px)`,
            background: 'linear-gradient(90deg, #3a3a5a 0%, #2a2a48 50%, #1a1a35 100%)',
          }}
        />

        {/* Bottom edge */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: `${depth}px`,
            transform: `rotateX(-90deg) translateZ(0px) translateY(${depth / 2}px)`,
            background: '#0e0e20',
          }}
        />

        {/* Badge */}
        {won !== undefined && (
          <div
            style={{
              position: 'absolute',
              top: isMobile ? '-5px' : '-8px',
              right: isMobile ? '-5px' : '-8px',
              zIndex: 10,
              transform: `translateZ(${depth / 2 + 4}px)`,
            }}
          >
            <div className={`${isMobile ? 'w-4 h-4' : 'w-6 h-6'} ${won ? 'bg-emerald-500' : 'bg-red-500/80'} rounded-full flex items-center justify-center shadow-lg`}
              style={{ boxShadow: won ? '0 2px 8px rgba(16,185,129,0.4)' : '0 2px 8px rgba(239,68,68,0.3)' }}
            >
              <span className={`text-white ${isMobile ? 'text-[7px]' : 'text-[10px]'} font-bold`}>{won ? numGuesses : '✕'}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 memory-card-screen flex flex-col" style={{ background: 'linear-gradient(160deg, #6b6b7b 0%, #4a4e5e 30%, #3d3f4f 70%, #32333f 100%)' }}>
      {/* Top bar */}
      <div className="flex items-start justify-between px-4 sm:px-6 pt-4 sm:pt-5 pb-2 sm:pb-3 relative z-10">
        <div>
          <div className="text-white/90 text-sm sm:text-lg font-medium" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Memory Card (PS2) / 1
          </div>
          <div className="text-white/40 text-[10px] sm:text-xs mt-0.5">
            {Object.keys(history).length} save{Object.keys(history).length !== 1 ? 's' : ''} • {slots.length} slots
          </div>
        </div>
        <div className="flex items-start gap-3 sm:gap-4">
          <div className="text-right min-h-[40px] sm:min-h-[48px]">
            {activeSlot && activeSlot.completed ? (
              <div className="memory-card-info-enter">
                <div className="text-white/90 text-sm sm:text-base font-semibold">{activeSlot.game.name}</div>
                <div className="text-white/50 text-[10px] sm:text-xs">
                  {activeSlot.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {' • '}
                  {activeSlot.completed.won 
                    ? `Won in ${activeSlot.completed.numGuesses}` 
                    : 'Game Over'
                  }
                </div>
              </div>
            ) : activeSlot && !activeSlot.completed ? (
              <div className="memory-card-info-enter">
                <div className="text-white/50 text-xs sm:text-sm">No Save Data</div>
                <div className="text-white/30 text-[10px] sm:text-xs">Click to play</div>
              </div>
            ) : null}
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors text-xl leading-none mt-0.5">&times;</button>
        </div>
      </div>

      {/* Grid area */}
      <div className="flex-1 flex items-center justify-center px-4 sm:px-8 overflow-y-auto" style={{ perspective: isMobile ? '600px' : '1200px', perspectiveOrigin: '50% 45%' }}>
        <div 
          className="w-full"
          style={{ 
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: isMobile ? '4px 14px' : '0px 16px',
            maxWidth: isMobile ? '340px' : '48rem',
            transformStyle: 'preserve-3d',
            transform: isMobile ? 'rotateX(3deg)' : 'rotateX(5deg)',
          }}
        >
          {slots.map((slot, idx) => {
            const row = Math.floor(idx / cols);
            const rowOffset = isMobile
              ? (row === 1 ? -8 : row === 2 ? -16 : row === 3 ? -24 : 0)
              : (row === 1 ? -60 : row === 2 ? -50 : 0);

            return (
            <div
              key={slot.dateKey}
              className="memory-card-slot flex flex-col items-center"
              style={{ 
                perspective: isMobile ? '400px' : '800px',
                zIndex: hoveredSlot === idx ? 50 : (row + 1) * 10 + (cols - idx % cols),
                position: 'relative',
                marginTop: `${rowOffset}px`,
              }}
              onMouseEnter={() => setHoveredSlot(idx)}
              onMouseLeave={() => setHoveredSlot(null)}
              onClick={() => handleSlotClick(slot, idx)}
            >
              {slot.completed ? (
                <div 
                  className="memory-card-icon w-full cursor-pointer" 
                  style={{ 
                    aspectRatio: '3/4',
                    transformStyle: 'preserve-3d',
                  }}
                >
                  <GameCase3D
                    coverUrl={slot.game.coverUrl}
                    alt={slot.game.name}
                    isHovered={hoveredSlot === idx}
                    won={slot.completed.won}
                    numGuesses={slot.completed.numGuesses}
                    variation={slotVariations[idx]}
                  />
                  {/* Floor shadow */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: '-8px',
                      left: '5%',
                      width: '90%',
                      height: isMobile ? '6px' : '12px',
                      background: 'radial-gradient(ellipse, rgba(0,0,0,0.35) 0%, transparent 70%)',
                      transition: 'all 0.35s ease',
                      opacity: hoveredSlot === idx ? 0.3 : 0.5,
                      transform: hoveredSlot === idx ? 'scaleX(1.2) translateY(4px)' : 'scaleX(1)',
                    }}
                  />
                </div>
              ) : (
                <div className="w-full cursor-pointer flex items-center justify-center" style={{ aspectRatio: '3/4' }}>
                  <div 
                    className="plumbob-container transition-all duration-300"
                    style={{
                      transform: hoveredSlot === idx ? 'scale(1.15) translateY(-4px)' : 'scale(1)',
                    }}
                  >
                    <svg 
                      width={isMobile ? '24' : '36'} height={isMobile ? '32' : '48'} viewBox="0 0 36 48" 
                      className="plumbob-gem"
                      style={{
                        filter: hoveredSlot === idx 
                          ? 'drop-shadow(0 0 14px rgba(255,255,255,0.7)) drop-shadow(0 0 28px rgba(220,230,255,0.5)) drop-shadow(0 0 40px rgba(200,210,255,0.25))'
                          : 'drop-shadow(0 0 8px rgba(255,255,255,0.4)) drop-shadow(0 0 18px rgba(220,230,255,0.25)) drop-shadow(0 0 30px rgba(200,210,255,0.1))',
                        transition: 'filter 0.3s ease',
                      }}
                    >
                      <polygon points="18,0 36,18 18,22" fill="rgba(255,255,255,0.55)" />
                      <polygon points="18,0 0,18 18,22" fill="rgba(255,255,255,0.42)" />
                      <polygon points="0,18 36,18 18,22" fill="rgba(255,255,255,0.30)" />
                      <polygon points="18,48 36,18 18,22" fill="rgba(255,255,255,0.35)" />
                      <polygon points="18,48 0,18 18,22" fill="rgba(255,255,255,0.25)" />
                      <polygon points="0,18 36,18 18,22" fill="rgba(255,255,255,0.20)" />
                      <line x1="18" y1="0" x2="36" y2="18" stroke="rgba(255,255,255,0.6)" strokeWidth="0.7" />
                      <line x1="18" y1="0" x2="0" y2="18" stroke="rgba(255,255,255,0.5)" strokeWidth="0.7" />
                      <line x1="18" y1="48" x2="36" y2="18" stroke="rgba(255,255,255,0.35)" strokeWidth="0.5" />
                      <line x1="18" y1="48" x2="0" y2="18" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
                      <line x1="0" y1="18" x2="36" y2="18" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
                      <line x1="18" y1="22" x2="18" y2="0" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
                    </svg>
                  </div>
                </div>
              )}
              {/* Date label — only for unplayed slots */}
              {!slot.completed && (
                <div className={`-mt-6 sm:-mt-11 text-[9px] sm:text-[13px] font-semibold tracking-wider transition-colors duration-200 ${
                  hoveredSlot === idx ? 'text-white' : 'text-white/75'
                }`}>
                  {slot.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}
                </div>
              )}
            </div>
          ); })}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Feedback Form Component
// ============================================
function FeedbackForm() {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

  const ATTRIBUTES = ['Genre', 'Platform', 'Release Year', 'Art Style', 'Setting', 'Theme', 'Protagonist Gender', 'Protagonist Type', 'Franchise', 'Other'];

  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState('attribute');
  const [form, setForm] = React.useState({ game: '', attribute: '', correction: '', message: '' });
  const [status, setStatus] = React.useState('idle'); // 'idle' | 'loading' | 'success' | 'error'

  function reset() {
    setForm({ game: '', attribute: '', correction: '', message: '' });
    setStatus('idle');
  }

  function close() {
    setOpen(false);
    setTimeout(reset, 300);
  }

  async function handleSubmit() {
    setStatus('loading');
    try {
      const payload = { type };
      if (type === 'attribute') {
        payload.game = form.game;
        payload.attribute = form.attribute;
        payload.correction = form.correction;
      } else if (type === 'add_game') {
        payload.game = form.game;
        payload.message = form.message;
      } else {
        payload.message = form.message;
      }

      const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 201 || res.status === 204 || res.ok) {
        setStatus('success');
        setTimeout(close, 2000);
        return;
      }
      throw new Error();
    } catch {
      setStatus('error');
    }
  }

  const isValid = () => {
    if (type === 'attribute') return form.game && form.attribute && form.correction;
    if (type === 'add_game') return !!form.game;
    return form.message.length > 3;
  };

  const INPUT = "w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500";
  const LABEL = "block text-zinc-400 text-xs mb-1";

  if (!open) return (
    <button onClick={() => setOpen(true)} className="text-blue-500 hover:text-blue-300 transition-colors hover:underline underline-offset-2">
      Think something's wrong? Let us know →
    </button>
  );

  return (
    <div className="mt-3 mx-auto max-w-xs text-left bg-zinc-900 border border-zinc-700 rounded-lg p-4 shadow-xl" style={{ animation: 'fadeIn 0.2s ease-out' }}>
      {status === 'success' ? (
        <div className="text-center text-green-400 py-3 font-semibold text-sm">✓ Got it — thanks!</div>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-zinc-300 font-semibold text-sm">Send Feedback</span>
            <button onClick={close} className="text-zinc-500 hover:text-zinc-300 text-xl leading-none">×</button>
          </div>

          {/* Type tabs */}
          <div className="flex gap-1 mb-4 bg-zinc-800 rounded-lg p-1">
            {[['attribute', '⚠️ Wrong attribute'], ['add_game', '➕ Add a game'], ['general', '💬 General']].map(([val, label]) => (
              <button key={val} onClick={() => { setType(val); reset(); }}
                className={`flex-1 text-center px-2 py-1 rounded-md text-xs font-semibold transition-colors ${type === val ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Attribute form */}
          {type === 'attribute' && (
            <div className="space-y-2">
              <div>
                <label className={LABEL}>Game name <span className="text-red-400">*</span></label>
                <input type="text" placeholder="e.g. Hollow Knight" value={form.game}
                  onChange={e => setForm(f => ({ ...f, game: e.target.value }))} className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>Which attribute? <span className="text-red-400">*</span></label>
                <select value={form.attribute} onChange={e => setForm(f => ({ ...f, attribute: e.target.value }))} className={INPUT}>
                  <option value="">Select...</option>
                  {ATTRIBUTES.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL}>What should it be? <span className="text-red-400">*</span></label>
                <input type="text" placeholder='e.g. "Cel-Shaded", not "Stylized"' value={form.correction}
                  onChange={e => setForm(f => ({ ...f, correction: e.target.value }))} className={INPUT} />
              </div>
            </div>
          )}

          {/* Add game form */}
          {type === 'add_game' && (
            <div className="space-y-2">
              <div>
                <label className={LABEL}>Game name <span className="text-red-400">*</span></label>
                <input type="text" placeholder="e.g. Bully" value={form.game}
                  onChange={e => setForm(f => ({ ...f, game: e.target.value }))} className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>Anything else? (platform, year…)</label>
                <textarea placeholder="Optional extra info" value={form.message} rows={2}
                  onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  className={`${INPUT} resize-none`} />
              </div>
            </div>
          )}

          {/* General form */}
          {type === 'general' && (
            <div>
              <label className={LABEL}>What's on your mind? <span className="text-red-400">*</span></label>
              <textarea placeholder="Feedback, bug, suggestion…" value={form.message} rows={4}
                onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                className={`${INPUT} resize-none`} />
            </div>
          )}

          {status === 'error' && (
            <p className="text-red-400 text-xs mt-2">Something went wrong — try again.</p>
          )}

          <button onClick={handleSubmit} disabled={!isValid() || status === 'loading'}
            className="mt-3 w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded py-1.5 text-xs font-semibold transition-colors">
            {status === 'loading' ? 'Sending…' : 'Submit'}
          </button>
        </>
      )}
    </div>
  );
}

// ============================================
// Main Game Component
// ============================================
function App() {
  const [targetGame, setTargetGame] = useState(() => getTodaysGame());
  const [guesses, setGuesses] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [gameWon, setGameWon] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [showHowToPlay, setShowHowToPlay] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showMemoryCard, setShowMemoryCard] = useState(false);
  const [menuTab, setMenuTab] = useState('archive');
  const [gameMode, setGameMode] = useState('daily');
  const [customGameId, setCustomGameId] = useState(null);
  const [archiveDate, setArchiveDate] = useState(null);
  const [createSearchTerm, setCreateSearchTerm] = useState('');
  const [stats, setStats] = useState(() => loadStats());
  const [alreadyPlayed, setAlreadyPlayed] = useState(false);
  const [showPrevLevel, setShowPrevLevel] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);
  const headerMenuRef = useRef(null);

  // Auth & social
  const { user, login, signup, logout } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  const MAX_GUESSES = 10;

  // Get yesterday's game for "Previous Level" feature
  const yesterdayGame = useMemo(() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return getGameForDate(yesterday);
  }, []);

  // Sync stats from cloud when user logs in or switches accounts
  useEffect(() => {
    if (!user) {
      // Logged out — reset to localStorage stats (or fresh)
      setStats(loadStats());
      return;
    }

    const syncFromCloud = async () => {
      // Clear local today state first to prevent old account bleed
      localStorage.removeItem('metaguess-today');

      // Reset game state to fresh
      const todayGame = getTodaysGame();
      setTargetGame(todayGame);
      setGuesses([]);
      setGameOver(false);
      setGameWon(false);
      setAlreadyPlayed(false);

      // Fetch this user's stats from cloud
      const cloudStats = await fetchCloudStats(user.id);
      if (cloudStats) {
        saveStats(cloudStats);
        setStats(cloudStats);
      } else {
        // New user with no cloud data — start fresh
        const freshStats = {
          gamesPlayed: 0, gamesWon: 0, currentStreak: 0, maxStreak: 0,
          guessDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 },
          lastPlayedDate: null, lastGameNumber: null,
        };
        saveStats(freshStats);
        setStats(freshStats);
      }

      // Check if THIS user already played today
      const params = new URLSearchParams(window.location.search);
      if (gameMode === 'daily' && !params.get('game')) {
        const todayResult = await checkTodayPlayed(user.id, getTodayKey());
        if (todayResult && todayResult.guess_ids?.length > 0) {
          const rebuilt = reconstructGuesses(todayResult.guess_ids, todayGame);
          if (rebuilt.length > 0) {
            setGuesses(rebuilt);
            setGameOver(true);
            setGameWon(todayResult.won);
            setAlreadyPlayed(true);
            saveTodayState(todayResult.guess_ids, todayResult.won, true);
          }
        }
      }
    };
    syncFromCloud();
  }, [user]);

  // Navigate home helper
  const goHome = async () => {
    window.history.pushState({}, '', '/');
    const todayGame = getTodaysGame();
    setTargetGame(todayGame);
    setGameMode('daily');
    setGuesses([]);
    setGameWon(false);
    setGameOver(false);
    setShowMenu(false);
    setShowHeaderMenu(false);
    setShowMemoryCard(false);
    setGameStarted(false);
    setShowPrevLevel(false);

    // Restore today's state — cloud for logged-in users, localStorage for guests
    if (user) {
      const todayResult = await checkTodayPlayed(user.id, getTodayKey());
      if (todayResult && todayResult.guess_ids?.length > 0) {
        const rebuilt = reconstructGuesses(todayResult.guess_ids, todayGame);
        if (rebuilt.length > 0) {
          setGuesses(rebuilt);
          setGameOver(true);
          setGameWon(todayResult.won);
          setAlreadyPlayed(true);
        }
      }
    } else {
      const savedState = loadTodayState();
      if (savedState) {
        const restored = reconstructGuesses(savedState.guesses, todayGame);
        setGuesses(restored);
        setGameWon(savedState.gameWon);
        setGameOver(savedState.gameOver);
      }
    }
  };

  // Check URL for custom game or WCF route on mount
  useEffect(() => {
    if (window.location.pathname === '/which-came-first') {
      setGameMode('wcf');
      return;
    }
    if (window.location.pathname === '/linked') {
      setGameMode('linked');
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const customId = params.get('game');
    if (customId) {
      const game = GAMES_DATABASE.find(g => g.id === parseInt(customId));
      if (game) {
        setTargetGame(game);
        setGameMode('custom');
        setCustomGameId(parseInt(customId));
      }
    }
  }, []);

  // Migrate today's completed game to history on load
  useEffect(() => {
    const savedState = loadTodayState();
    if (savedState && savedState.gameOver) {
      const todayGame = getTodaysGame();
      saveToHistory(
        savedState.dateKey,
        todayGame.id,
        savedState.gameWon,
        savedState.guesses.length
      );
    }
  }, []);

  // Reset game for archive/custom modes
  const startGame = (game, mode, archiveDateKey = null) => {
    setTargetGame(game);
    setGameMode(mode);
    setGuesses([]);
    setGameWon(false);
    setGameOver(false);
    setShowMenu(false);
    setShowMemoryCard(false);
    setArchiveDate(archiveDateKey);
    if (mode === 'custom') {
      setCustomGameId(game.id);
    }
  };

  // Generate shareable link
  const generateShareLink = (gameId) => {
    const baseUrl = window.location.origin + window.location.pathname;
    return `${baseUrl}?game=${gameId}`;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  // Load saved game state on mount (only for daily mode)
  // Skip if logged in — cloud sync handles restoration
  useEffect(() => {
    if (user) return;
    if (gameMode !== 'daily') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('game')) return;
    
    const savedState = loadTodayState();
    if (savedState) {
      const restored = reconstructGuesses(savedState.guesses, targetGame);
      setGuesses(restored);
      setGameWon(savedState.gameWon);
      setGameOver(savedState.gameOver);
      setAlreadyPlayed(savedState.gameOver);
    }
  }, [targetGame, gameMode]);

  // Update stats when game ends
  const updateStats = (won, numGuesses) => {
    const newStats = { ...stats };
    const gameNumber = getGameNumber();
    
    if (newStats.lastGameNumber === gameNumber) return;
    
    newStats.gamesPlayed += 1;
    newStats.lastPlayedDate = getTodayKey();
    newStats.lastGameNumber = gameNumber;
    
    if (won) {
      newStats.gamesWon += 1;
      newStats.guessDistribution[numGuesses] = (newStats.guessDistribution[numGuesses] || 0) + 1;
      
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth() + 1}-${yesterday.getDate()}`;
      
      if (newStats.lastPlayedDate === yesterdayKey || newStats.currentStreak === 0) {
        newStats.currentStreak += 1;
      } else {
        newStats.currentStreak = 1;
      }
      
      if (newStats.currentStreak > newStats.maxStreak) {
        newStats.maxStreak = newStats.currentStreak;
      }
    } else {
      newStats.currentStreak = 0;
    }
    
    setStats(newStats);
    saveStats(newStats);
  };

  // Filter games for autocomplete
  // Roman numeral maps are defined at component level for reuse
  const romanToArabic = { 'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10', 'xi': '11', 'xii': '12', 'xiii': '13', 'xiv': '14', 'xv': '15' };
  const arabicToRoman = Object.fromEntries(Object.entries(romanToArabic).map(([k, v]) => [v, k]));

  const filteredGames = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const term = searchTerm.toLowerCase().trim();
    
    // Build alternate search term — try converting numbers to roman OR roman to numbers
    let altTerm = term;
    const hasNumbers = /\b\d{1,2}\b/.test(term);
    const hasRoman = /\b(xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/.test(term);
    if (hasNumbers && !hasRoman) {
      altTerm = term.replace(/\b(\d{1,2})\b/g, (_, n) => arabicToRoman[n] || n);
    } else if (hasRoman && !hasNumbers) {
      altTerm = term.replace(/\b(xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/g, (_, r) => romanToArabic[r] || r);
    }

    const matches = GAMES_DATABASE
      .filter(game => {
        if (guesses.find(g => g.id === game.id)) return false;
        const name = game.name.toLowerCase();
        return name.includes(term) || (altTerm !== term && name.includes(altTerm));
      })
      .sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aStarts = aName.startsWith(term) || (altTerm !== term && aName.startsWith(altTerm));
        const bStarts = bName.startsWith(term) || (altTerm !== term && bName.startsWith(altTerm));
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        // Secondary: prefer earlier match position
        const aIdx = Math.min(aName.indexOf(term), altTerm !== term ? (aName.indexOf(altTerm) >>> 0) : 999);
        const bIdx = Math.min(bName.indexOf(term), altTerm !== term ? (bName.indexOf(altTerm) >>> 0) : 999);
        return aIdx - bIdx;
      })
      .slice(0, 8);
    
    return matches;
  }, [searchTerm, guesses]);

  // Handle game selection
  const selectGame = (game) => {
    if (gameOver) return;
    
    const feedback = {
      ...game,
      feedback: {
        name: game.id === targetGame.id ? 'correct' : 'wrong',
        year: compareValues(game.year, targetGame.year, 'year'),
        artStyle: compareValues(game.artStyle, targetGame.artStyle, 'exact'),
        platform: compareValues(game.platform, targetGame.platform, 'platform'),
        protagonistType: compareValues(game.protagonistType, targetGame.protagonistType, 'exact'),
        protagonistGender: compareValues(game.protagonistGender, targetGame.protagonistGender, 'exact'),
        setting: compareValues(game.setting, targetGame.setting, 'exact'),
        primaryGenre: compareValues(game.primaryGenre, targetGame.primaryGenre, 'exact'),
        genres: compareValues(game.genres?.slice(0, 3), targetGame.genres?.slice(0, 3), 'array'),
        publisher: compareValues(game.publisher, targetGame.publisher, 'exact'),
        isMultiplayer: compareValues(game.isMultiplayer, targetGame.isMultiplayer, 'boolean'),
        perspective: compareValues(game.perspective, targetGame.perspective, 'exact'),
        franchise: (game.franchise === null && targetGame.franchise === null) ? 'correct' : (game.franchise && targetGame.franchise) ? compareValues(game.franchise, targetGame.franchise, 'exact') : 'wrong',
        rating: compareValues(game.popularityRank, targetGame.popularityRank, 'rank'),
      }
    };

    const newGuesses = [...guesses, feedback];
    setGuesses(newGuesses);
    setSearchTerm('');
    setShowDropdown(false);

    const won = game.id === targetGame.id;
    const isOver = won || newGuesses.length >= MAX_GUESSES;
    
    if (won) setGameWon(true);
    
    if (isOver) {
      setGameOver(true);
      if (gameMode === 'daily') {
        updateStats(won, newGuesses.length);
        saveToHistory(getTodayKey(), targetGame.id, won, newGuesses.length);
        // Save to Supabase leaderboard
        if (user) {
          saveScore(user.id, getTodayKey(), getGameNumber(), won, newGuesses.length, newGuesses.map(g => g.id));
        }
        if (won) {
          setTimeout(() => setShowStats(true), 2500);
        }
      }
      if (gameMode === 'archive' && archiveDate) {
        saveToHistory(archiveDate, targetGame.id, won, newGuesses.length);
      }
    }
    
    if (gameMode === 'daily') {
      saveTodayState(newGuesses.map(g => g.id), won, isOver);
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          inputRef.current && !inputRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close header menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) {
        setShowHeaderMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Generate share text
  const [shareCopied, setShareCopied] = useState(false);
  
  const generateShareText = () => {
    const gameNum = gameMode === 'daily' ? `#${getGameNumber()}` : gameMode === 'archive' ? '📅' : '✨';
    const totalBars = 10;
    const url = gameMode === 'custom' 
      ? generateShareLink(customGameId) 
      : window.location.origin + window.location.pathname;
    
    const hpRemaining = Math.round(totalBars * (1 - guesses.length / MAX_GUESSES));
    const filled = '█'.repeat(hpRemaining);
    const empty = '░'.repeat(totalBars - hpRemaining);
    const icon = gameWon ? '☠️' : '❤️‍🩹';
    const status = gameWon 
      ? `Game defeated in ${guesses.length} hit${guesses.length === 1 ? '' : 's'}!` 
      : `I lost!`;
    
    return `MetaGuess ${gameNum} ⚔️\n\n${icon} ${filled}${empty}\n\n${status}\n${url}`;
  };

  const handleShare = () => {
    const text = generateShareText();
    navigator.clipboard.writeText(text);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const isGameOver = gameOver;

  // Feedback cell component
  const FeedbackCell = ({ label, value, feedback, displayValue }) => {
    const bgColor = {
      correct: 'bg-emerald-500 cell-correct',
      partial: 'bg-amber-500 cell-partial',
      wrong: 'bg-zinc-600',
      higher: 'bg-zinc-600',
      lower: 'bg-zinc-600',
      unknown: 'bg-zinc-500',
      partial_higher: 'bg-amber-500 cell-partial',
      partial_lower: 'bg-amber-500 cell-partial',
    }[feedback];

    // In the arrow line, add the partial cases:
      const arrow = (feedback === 'higher' || feedback === 'partial_higher') ? ' ↑' 
                  : (feedback === 'lower' || feedback === 'partial_lower') ? ' ↓' 
                  : '';
    return (
      <div className={`${bgColor} p-1.5 sm:p-3 rounded-lg sm:rounded-xl flex flex-col items-center justify-center text-center min-h-[50px] sm:min-h-[70px] transition-all duration-300 overflow-hidden`}>
        <span className="text-white/50 text-[9px] sm:text-[11px] mb-0.5 sm:mb-1">{label}</span>
        <span className="font-bold text-white text-[10px] sm:text-[15px] leading-tight break-words w-full">
          {displayValue ?? (typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value)}
          {arrow}
        </span>
      </div>
    );
  };

  // Genre cell with individual genre highlighting
  const GenreCell = ({ guessGenres, targetGenres, feedback }) => {
    const genres = guessGenres?.slice(0, 3) || [];
    const targetSet = new Set((targetGenres || []).map(g => g.toLowerCase()));
    
    const cellBg = feedback === 'correct' ? 'bg-emerald-500 cell-correct' : 'bg-zinc-600';
    
    return (
      <div className={`${cellBg} p-1.5 sm:p-3 rounded-lg sm:rounded-xl flex flex-col items-center justify-center text-center min-h-[50px] sm:min-h-[70px] transition-all duration-300`}>
        <span className="text-white/50 text-[9px] sm:text-[11px] mb-0.5 sm:mb-1">Genres</span>
        <div className="flex flex-wrap justify-center gap-0.5 sm:gap-1">
          {genres.map((genre, i) => {
            const matches = targetSet.has(genre.toLowerCase());
            return (
              <span
                key={i}
                className={`inline-block px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[12px] font-bold leading-tight ${
                  feedback === 'correct'
                    ? 'bg-emerald-600/50 text-white'
                    : matches
                      ? 'bg-amber-500 text-white'
                      : 'bg-zinc-500 text-white/70'
                }`}
              >
                {genre}
              </span>
            );
          })}
        </div>
      </div>
    );
  };
  const NextGameCountdown = () => {
    const [timeLeft, setTimeLeft] = useState('');
    
    useEffect(() => {
      const updateCountdown = () => {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        
        const diff = tomorrow - now;
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        setTimeLeft(`${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
      };
      
      updateCountdown();
      const interval = setInterval(updateCountdown, 1000);
      return () => clearInterval(interval);
    }, []);
    
    return <span className="font-mono font-bold text-blue-300">{timeLeft}</span>;
  };

  // Stats Modal
  const statsModalContent = (() => {
    if (!showStats) return null;
    
    const winRate = stats.gamesPlayed > 0 
      ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100) 
      : 0;
    const losses = stats.gamesPlayed - stats.gamesWon;
    
    const maxDistribution = Math.max(...Object.values(stats.guessDistribution), 1);
    
    const handleResetStats = () => {
      if (confirm('Reset all stats? This clears your play history and cannot be undone.')) {
        const freshStats = {
          gamesPlayed: 0,
          gamesWon: 0,
          currentStreak: 0,
          maxStreak: 0,
          guessDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 },
          lastPlayedDate: null,
          lastGameNumber: null,
        };
        saveStats(freshStats);
        setStats(freshStats);
        localStorage.removeItem('metaguess-history');
      }
    };
    
    return (
      <div className="fixed inset-0 ps2-modal-bg flex items-center justify-center z-50 p-4" onClick={() => setShowStats(false)}>
        <div className="ps2-modal rounded-2xl p-5 sm:p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg sm:text-xl font-bold text-blue-100">Statistics</h2>
            <button onClick={() => setShowStats(false)} className="text-blue-400 hover:text-white text-2xl">&times;</button>
          </div>
          
          {/* Main stats row */}
          <div className="grid grid-cols-5 gap-1 sm:gap-2 mb-5 text-center">
            <div>
              <div className="text-xl sm:text-2xl font-bold text-white">{stats.gamesPlayed}</div>
              <div className="text-[10px] sm:text-xs text-blue-400">Played</div>
            </div>
            <div>
              <div className="text-xl sm:text-2xl font-bold text-emerald-400">{stats.gamesWon}</div>
              <div className="text-[10px] sm:text-xs text-blue-400">Wins</div>
            </div>
            <div>
              <div className="text-xl sm:text-2xl font-bold text-red-400">{losses}</div>
              <div className="text-[10px] sm:text-xs text-blue-400">Losses</div>
            </div>
            <div>
              <div className="text-xl sm:text-2xl font-bold text-white">{stats.currentStreak}</div>
              <div className="text-[10px] sm:text-xs text-blue-400">Streak</div>
            </div>
            <div>
              <div className="text-xl sm:text-2xl font-bold text-white">{stats.maxStreak}</div>
              <div className="text-[10px] sm:text-xs text-blue-400">Best</div>
            </div>
          </div>

          {/* Win rate bar */}
          <div className="mb-5">
            <div className="flex justify-between text-[10px] sm:text-xs text-blue-400 mb-1">
              <span>Win Rate</span>
              <span className="font-bold text-white">{winRate}%</span>
            </div>
            <div className="h-2 bg-[#0a0a1a] rounded-full overflow-hidden">
              <div 
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${winRate}%` }}
              />
            </div>
          </div>
          
          <h3 className="text-xs sm:text-sm font-semibold text-blue-300 mb-3">Guess Distribution</h3>
          <div className="space-y-[6px]">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(num => {
              const count = stats.guessDistribution[num] || 0;
              const width = count > 0 ? Math.max((count / maxDistribution) * 100, 12) : 6;
              const isCurrentGame = gameWon && guesses.length === num;
              return (
                <div key={num} className="flex items-center gap-2">
                  <div className="w-4 text-xs font-medium text-blue-400 text-right">{num}</div>
                  <div className="flex-1 h-6 bg-[#0a0a1a] rounded-sm overflow-hidden">
                    <div 
                      className={`h-full rounded-sm flex items-center justify-end px-2 transition-all duration-700 ${
                        isCurrentGame ? 'bg-emerald-500' : count > 0 ? 'bg-blue-800' : 'bg-[#12122a]'
                      }`}
                      style={{ width: `${width}%` }}
                    >
                      {count > 0 && <span className="text-xs font-bold text-white">{count}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          
          {isGameOver && (
            <div className="mt-6 pt-4 border-t border-blue-900/50 text-center">
              <div className="text-xs text-blue-400 mb-1">Next game</div>
              <NextGameCountdown />
            </div>
          )}
          
          <button
            onClick={handleResetStats}
            className="mt-4 w-full text-[10px] text-red-400/40 hover:text-red-400 transition-colors py-1"
          >
            Reset Stats
          </button>
        </div>
      </div>
    );
  })();
  
  // Menu Modal (Create & Share only now — Past Games uses Memory Card)
  const menuModalContent = (() => {
    if (!showMenu) return null;
    
    const createFilteredGames = createSearchTerm.trim() 
      ? (() => {
          const term = createSearchTerm.toLowerCase().trim();
          const altTerm = (() => {
            const hasNumbers = /\b\d{1,2}\b/.test(term);
            const hasRoman = /\b(xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/.test(term);
            if (hasNumbers && !hasRoman) return term.replace(/\b(\d{1,2})\b/g, (_, n) => arabicToRoman[n] || n);
            if (hasRoman && !hasNumbers) return term.replace(/\b(xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/g, (_, r) => romanToArabic[r] || r);
            return term;
          })();
          return GAMES_DATABASE
            .filter(g => {
              const name = g.name.toLowerCase();
              return name.includes(term) || (altTerm !== term && name.includes(altTerm));
            })
            .sort((a, b) => {
              const aName = a.name.toLowerCase();
              const bName = b.name.toLowerCase();
              const aStarts = aName.startsWith(term) || (altTerm !== term && aName.startsWith(altTerm));
              const bStarts = bName.startsWith(term) || (altTerm !== term && bName.startsWith(altTerm));
              if (aStarts && !bStarts) return -1;
              if (!aStarts && bStarts) return 1;
              return 0;
            })
            .slice(0, 8);
        })()
      : [];
    
    return (
      <div className="fixed inset-0 ps2-modal-bg flex items-center justify-center z-50 p-4" onClick={() => setShowMenu(false)}>
        <div className="ps2-modal rounded-2xl p-6 max-w-md w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-blue-100">✨ Create & Share</h2>
            <button onClick={() => setShowMenu(false)} className="text-blue-400 hover:text-white text-2xl">&times;</button>
          </div>
          
          <div className="flex-1">
            <p className="text-xs text-blue-500 mb-3">Pick a game and share the link with friends</p>
            
            <input
              type="text"
              value={createSearchTerm}
              onChange={(e) => setCreateSearchTerm(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder="Search for a game..."
              className="ps2-input w-full rounded-xl px-4 py-3 text-blue-100 placeholder-blue-600 mb-3"
              autoComplete="off"
            />
            
            {createFilteredGames.length > 0 && (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {createFilteredGames.map(game => {
                  const shareLink = generateShareLink(game.id);
                  return (
                    <div key={game.id} className="p-3 bg-[#0f0f22] rounded-lg border border-blue-900/30">
                      <div className="flex justify-between items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-blue-100 text-sm truncate">{game.name}</div>
                          <div className="text-xs text-blue-500">{game.year} • {game.genres?.slice(0, 2)?.join(', ')}</div>
                        </div>
                        <button
                          onClick={() => {
                            copyToClipboard(shareLink);
                            alert('Link copied! Share it with your friends.');
                          }}
                          className="flex-shrink-0 px-3 py-1.5 ps2-btn text-white rounded-lg text-xs"
                        >
                          Copy Link
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            
            {createSearchTerm && createFilteredGames.length === 0 && (
              <p className="text-sm text-blue-500 text-center py-4">No games found</p>
            )}
            
            {!createSearchTerm && (
              <p className="text-sm text-blue-600 text-center py-4">Start typing to search for a game</p>
            )}
          </div>
          
          {gameMode !== 'daily' && (
            <button onClick={goHome} className="mt-4 w-full py-2 ps2-btn text-white rounded-lg text-sm">
              ← Back to Today's Game
            </button>
          )}
        </div>
      </div>
    );
  })();

  // Which Came First mode — full-screen takeover
  if (gameMode === 'wcf') {
    return <WhichCameFirst onExit={goHome} />;
  }
  // Linked mode - full-screen takeover
  if (gameMode === 'linked') {
    return <Linked onExit={goHome} user={user} />;
  }
  return (
    <div className="min-h-screen ps2-bg text-white">
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.8; } }
      `}</style>
      {/* Memory Card Overlay */}
      {showMemoryCard && (
        <MemoryCardScreen
          onClose={() => setShowMemoryCard(false)}
          onPlayGame={(game, dateKey) => {
            startGame(game, 'archive', dateKey);
            setShowMemoryCard(false);
          }}
        />
      )}

      {/* Full-width Header Bar */}
      <div className="ps2-header w-full px-4 py-4 mb-6 relative z-40">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between relative">
            {/* Left: hamburger menu + game mode badge */}
            <div className="flex items-center gap-2 w-10 sm:w-36" ref={headerMenuRef}>
              <div className="relative">
                <button 
                  onClick={() => setShowHeaderMenu(!showHeaderMenu)}
                  className="p-2 text-blue-400 hover:text-blue-200 hover:bg-blue-900/30 rounded-lg transition-colors"
                  title="Menu"
                >
                  <div className="flex flex-col gap-[3px]">
                    <span className="block w-4 h-[2px] bg-current rounded"></span>
                    <span className="block w-4 h-[2px] bg-current rounded"></span>
                    <span className="block w-4 h-[2px] bg-current rounded"></span>
                  </div>
                </button>

                {showHeaderMenu && (
                  <div className="absolute top-full left-0 mt-2 w-48 ps2-dropdown rounded-xl overflow-hidden z-50 header-dropdown-enter">
                    <button
                      onClick={() => { setShowHowToPlay(!showHowToPlay); setShowHeaderMenu(false); }}
                      className="w-full px-4 py-3 text-left text-sm text-blue-200 hover:bg-[#141428] transition-colors border-b border-blue-900/20 flex items-center gap-3"
                    >
                      <span className="text-blue-500 text-base"></span> How to Play
                    </button>
                    <button
                      onClick={() => {
                        if (user) { setShowLeaderboard(true); } else { setShowLogin(true); }
                        setShowHeaderMenu(false);
                      }}
                      className="w-full px-4 py-3 text-left text-sm text-blue-200 hover:bg-[#141428] transition-colors border-b border-blue-900/20 flex items-center gap-3"
                    >
                      <span className="text-blue-500 text-base"></span> Leaderboard
                    </button>
                    <button
                      onClick={() => { setShowStats(true); setShowHeaderMenu(false); }}
                      className="w-full px-4 py-3 text-left text-sm text-blue-200 hover:bg-[#141428] transition-colors border-b border-blue-900/20 flex items-center gap-3"
                    >
                      <span className="text-blue-500 text-base"></span> Stats
                    </button>
                    <button
                      onClick={() => { setShowMemoryCard(true); setShowHeaderMenu(false); }}
                      className="w-full px-4 py-3 text-left text-sm text-blue-200 hover:bg-[#141428] transition-colors border-b border-blue-900/20 flex items-center gap-3"
                    >
                      <span className="text-blue-500 text-base"></span> Past Games
                    </button>
                    <button
                      onClick={() => { setMenuTab('create'); setShowMenu(true); setShowHeaderMenu(false); }}
                      className={`w-full px-4 py-3 text-left text-sm text-blue-200 hover:bg-[#141428] transition-colors flex items-center gap-3 ${user ? 'border-b border-blue-900/20' : ''}`}
                    >
                      <span className="text-blue-500 text-base"></span> Custom Game
                    </button>
                    <button
                      onClick={() => { 
                        window.history.pushState({}, '', '/linked');
                        setGameMode('linked'); 
                        setShowHeaderMenu(false); 
                      }}
                      className="w-full px-4 py-3 text-left text-sm text-blue-200 hover:bg-[#141428] transition-colors border-b border-blue-900/20 flex items-center gap-3"
                    >
                      <span className="text-blue-500 text-base"></span> Play Linked
                    </button>
                    <button
                      onClick={() => { 
                        window.history.pushState({}, '', '/which-came-first');
                        setGameMode('wcf'); 
                        setShowHeaderMenu(false); 
                      }}
                      className={`w-full px-4 py-3 text-left text-sm text-blue-200 hover:bg-[#141428] transition-colors flex items-center gap-3 ${user ? 'border-b border-blue-900/20' : ''}`}
                    >
                      <span className="text-blue-500 text-base"></span> Play Which Came First?
                    </button>
                    {user && (
                      <button
                        onClick={() => { 
                          logout(); 
                          setShowHeaderMenu(false);
                          // Clear local game state so next login starts clean
                          localStorage.removeItem('metaguess-today');
                          localStorage.removeItem('metaguess-stats');
                          setGuesses([]);
                          setGameOver(false);
                          setGameWon(false);
                          setAlreadyPlayed(false);
                          setStats(loadStats());
                        }}
                        className="w-full px-4 py-3 text-left text-sm text-red-400/70 hover:bg-[#141428] transition-colors flex items-center gap-3"
                      >
                        <span className="text-base"></span> Logout ({user.username})
                      </button>
                    )}
                  </div>
                )}
              </div>

              {gameMode === 'archive' && (
                <span className="text-amber-500 text-xs font-medium mt-2">Archive</span>
              )}
              {gameMode === 'custom' && (
                <span className="text-purple-400 text-xs font-medium mt-2">Custom</span>
              )}
            </div>

            {/* Center: Title */}
            <h1 className="absolute left-1/2 -translate-x-1/2 text-xl sm:text-3xl font-extrabold tracking-tight ps2-title whitespace-nowrap">
              MetaGuess
              <span className="ml-2 text-[10px] sm:text-xs font-medium bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full align-middle tracking-wide">BETA</span>
            </h1>

            {/* Right: Home button */}
            <div className="w-10 sm:w-36 flex justify-end gap-1">
              {/* User button */}
              <button
                onClick={() => user ? setShowLeaderboard(true) : setShowLogin(true)}
                className="p-2 text-blue-400 hover:text-blue-200 hover:bg-blue-900/30 rounded-lg transition-colors"
                title={user ? user.username : 'Log In'}
              >
                {user ? (
                  <div className="w-[18px] h-[18px] bg-blue-600 rounded-full flex items-center justify-center text-[10px] font-bold text-white">
                    {user.username[0].toUpperCase()}
                  </div>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                  </svg>
                )}
              </button>
              <button
                onClick={goHome}
                className="p-2 text-blue-400 hover:text-blue-200 hover:bg-blue-900/30 rounded-lg transition-colors"
                title="Home"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                  <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
              </button>
            </div>
          </div>
          
          {gameMode === 'daily' && (
            <p className="text-blue-500 text-sm text-center mt-1">Guess the video game in {MAX_GUESSES} tries</p>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 relative z-10">
        {/* How to Play */}
        {showHowToPlay && (
          <div className="bg-[#0d0d1a] border border-blue-900/30 rounded-xl p-4 mb-6 text-sm relative">
            <button 
              onClick={() => setShowHowToPlay(false)} 
              className="absolute top-3 right-3 text-blue-400 hover:text-white text-lg leading-none"
            >✕</button>
            <h3 className="font-bold mb-2 text-blue-200">How to Play</h3>
            <ul className="space-y-1 text-blue-300">
              <li>• Type a game name and select from the dropdown</li>
              <li>• <span className="text-emerald-400 font-semibold">Green</span> = Correct match</li>
              <li>• <span className="text-amber-400 font-semibold">Yellow</span> = Partial match (some overlap)</li>
              <li>• <span className="text-zinc-400 font-semibold">Gray</span> = No match</li>
              <li>• Arrows show if the target is ↑ higher or ↓ lower</li>
            </ul>
          </div>
        )}

        {/* Search Input with Health Bar */}
        {!isGameOver && (
          <>
            {/* Press Start screen - daily mode only, before game starts */}
            {gameMode === 'daily' && !gameStarted && guesses.length === 0 && !alreadyPlayed && (
              <div className="flex flex-col items-center mb-8 mt-16">
              {/* Tagline */}
              <div className="text-center mb-6" style={{ fontFamily: "'Outfit', sans-serif" }}>
                  <p className="text-blue-400/50 text-xs sm:text-sm tracking-wide mt-1">
                    Guess the video game
                  </p>
                  <p className="text-blue-400/50 text-xs sm:text-sm tracking-wide mt-1">
                    Will your health run out?
                  </p>
                </div>
                {/* Press Start Button */}
                <button
                  onClick={() => {
                    setGameStarted(true);
                    setTimeout(() => inputRef.current?.focus(), 100);
                  }}
                  className="group relative cursor-pointer mb-10"
                >
                  {/* Outer glow ring */}
                  <div className="absolute -inset-3 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    style={{ background: 'radial-gradient(ellipse, rgba(59,130,246,0.15) 0%, transparent 70%)' }} 
                  />
                  {/* Button body */}
                  <div className="relative px-12 py-5 rounded-xl border-2 border-blue-500/40 group-hover:border-blue-400/70 transition-all duration-300"
                    style={{
                      background: 'linear-gradient(180deg, rgba(30,58,138,0.5) 0%, rgba(15,23,42,0.8) 100%)',
                      boxShadow: '0 0 20px rgba(59,130,246,0.15), inset 0 1px 0 rgba(147,197,253,0.1), inset 0 -2px 0 rgba(0,0,0,0.3)',
                    }}
                  >
                    {/* Play triangle */}
                    <div className="flex items-center gap-4">
                      <div 
                        className="w-0 h-0 border-t-[14px] border-t-transparent border-b-[14px] border-b-transparent border-l-[22px] border-l-blue-400/80 group-hover:border-l-blue-300 transition-colors"
                      />
                      <span className="text-2xl font-bold tracking-[0.2em] uppercase text-blue-300/90 group-hover:text-blue-200 transition-colors"
                        style={{ fontFamily: "'Outfit', sans-serif", textShadow: '0 0 12px rgba(147,197,253,0.3)' }}
                      >
                        Press Start
                      </span>
                    </div>
                  </div>
                </button>

                {/* Previous Level */}
                {yesterdayGame && (
                  <div 
                    className="flex items-center gap-5 cursor-pointer group"
                    onClick={() => setShowPrevLevel(!showPrevLevel)}
                  >
                    {/* Monitor */}
                    <div className="relative w-24 h-20 flex-shrink-0 mb-3">
                      <div className={`absolute inset-0 rounded-lg border-2 ${showPrevLevel ? 'border-blue-400/70 bg-zinc-900' : 'border-zinc-600/50 bg-zinc-800/60'} transition-all duration-500 overflow-hidden`}>
                        {showPrevLevel && yesterdayGame.coverUrl && (
                          <img 
                            src={`https:${yesterdayGame.coverUrl}`}
                            alt={yesterdayGame.name}
                            className="w-full h-full object-cover"
                            style={{ animation: 'fadeIn 0.4s ease-in' }}
                          />
                        )}
                      </div>
                      {/* Monitor stand */}
                      <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-6 h-2 bg-zinc-700 rounded-sm" />
                      <div className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 w-10 h-1.5 bg-zinc-700 rounded-sm" />
                      {showPrevLevel && (
                        <div className="absolute inset-0 rounded-lg shadow-[0_0_18px_rgba(59,130,246,0.35)] pointer-events-none" />
                      )}
                    </div>
                    {/* Text */}
                    <div className="text-left">
                      {!showPrevLevel ? (
                        <div className="text-base font-bold tracking-wide text-zinc-500 group-hover:text-zinc-400 transition-colors">
                          Previous Level
                        </div>
                      ) : (
                        <div style={{ animation: 'fadeIn 0.4s ease-in' }}>
                          <div className="text-xl font-bold text-blue-200 leading-tight">{yesterdayGame.name}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Search Input with Health Bar - shows after Press Start or in non-daily modes */}
            {(gameStarted || gameMode !== 'daily' || guesses.length > 0 || alreadyPlayed) && (
              <div className="relative mb-8 max-w-md mx-auto">
                <div className="mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-blue-400">HP</span>
                    <span className="text-[10px] font-medium text-blue-500">{MAX_GUESSES - guesses.length} / {MAX_GUESSES}</span>
                  </div>
                  <div className="h-2 w-full bg-[#0a0a1a] rounded-full overflow-hidden border border-blue-900/30">
                    <div 
                      className="h-full rounded-full transition-all duration-500 ease-out"
                      style={{ 
                        width: `${((MAX_GUESSES - guesses.length) / MAX_GUESSES) * 100}%`,
                        background: (MAX_GUESSES - guesses.length) <= 3 
                          ? 'linear-gradient(90deg, #dc2626, #ef4444)' 
                          : (MAX_GUESSES - guesses.length) <= 6 
                            ? 'linear-gradient(90deg, #d97706, #f59e0b)' 
                            : 'linear-gradient(90deg, #1d4ed8, #3b82f6)',
                        boxShadow: (MAX_GUESSES - guesses.length) <= 3
                          ? '0 0 8px rgba(239, 68, 68, 0.4)'
                          : (MAX_GUESSES - guesses.length) <= 6
                            ? '0 0 8px rgba(245, 158, 11, 0.3)'
                            : '0 0 8px rgba(59, 130, 246, 0.3)'
                      }}
                    />
                  </div>
                </div>

                <input
                  ref={inputRef}
                  type="text"
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setShowDropdown(true);
                  }}
                  onFocus={() => setShowDropdown(true)}
                  placeholder="Type a game name..."
                  className="ps2-input w-full rounded-lg px-3 py-2.5 text-base sm:text-sm text-blue-100 placeholder-blue-600"
                />
                
                {showDropdown && filteredGames.length > 0 && (
                  <div 
                    ref={dropdownRef}
                    className="absolute w-full mt-2 ps2-dropdown rounded-xl overflow-hidden z-10 max-h-80 overflow-y-auto"
                  >
                    {filteredGames.map(game => (
                      <div
                        key={game.id}
                        onClick={() => selectGame(game)}
                        className="dropdown-item px-4 py-3 cursor-pointer border-b border-blue-900/20 last:border-0"
                      >
                        <div className="font-medium text-blue-100">{game.name}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Win/Lose Reveal */}
        {isGameOver && (
          <div className="mb-6 flex flex-col items-center">
            {targetGame.coverUrl && (
              <div className={`relative ${gameWon ? 'animate-bounce-once' : ''}`}>
                <img 
                  src={`https:${targetGame.coverUrl}`} 
                  alt={targetGame.name}
                  className={`w-48 h-64 object-cover rounded-2xl shadow-2xl ${
                    gameWon 
                      ? 'ring-4 ring-emerald-400 shadow-emerald-500/30' 
                      : 'ring-4 ring-zinc-600 shadow-zinc-500/30 grayscale'
                  }`}
                />
                {gameWon && (
                  <div className="absolute -top-3 -right-3 bg-emerald-500 text-white rounded-full w-10 h-10 flex items-center justify-center text-lg font-bold shadow-lg">
                    {guesses.length}
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 text-center">
              {gameWon ? (
                <>
                  <div className="text-xl font-bold text-white">{targetGame.name}</div>
                  <div className="text-emerald-400 text-sm mt-1">Completed it in {guesses.length} {guesses.length === 1 ? 'guess' : 'guesses'}</div>
                  {gameMode === 'daily' && (
                    <div className="mt-2">
                      <div className="text-xs text-zinc-400">Next game in <NextGameCountdown /></div>
                      <div className="text-xs text-zinc-500 mt-1">Want more? Try <span className="text-blue-400 cursor-pointer hover:underline" onClick={() => setShowMemoryCard(true)}>Past Games</span> from the menu!</div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-xl font-bold text-white">{targetGame.name}</div>
                  <div className="text-blue-400 text-sm mt-1">Game Over</div>
                  {gameMode === 'daily' && (
                    <div className="mt-2">
                      <div className="text-xs text-zinc-400">Next game in <NextGameCountdown /></div>
                      <div className="text-xs text-zinc-500 mt-1">Want more? Try <span className="text-blue-400 cursor-pointer hover:underline" onClick={() => setShowMemoryCard(true)}>Past Games</span> from the menu!</div>
                    </div>
                  )}
                </>
              )}
              <div className="mt-3 flex justify-center gap-2">
                <button onClick={() => setShowStats(true)} className="px-5 py-2 ps2-btn text-white rounded-full text-sm">
                  View Stats
                </button>
                <button 
                  onClick={handleShare}
                  className={`px-5 py-2 rounded-full text-sm transition-colors ${
                    shareCopied ? 'bg-emerald-500 text-white' : 'bg-zinc-700 text-white hover:bg-zinc-600'
                  }`}
                >
                  {shareCopied ? '✓ Copied!' : '⚔️ Share'}
                </button>
              </div>
              
              {/* Kingdom Hearts style death scene — only on loss */}
              {!gameWon && (
                <div className="mt-6 mb-3 flex flex-col items-center">
                  <div className="kh-death-scene" style={{ width: '200px', height: '200px', position: 'relative' }}>
                    
                    {/* Ambient particles / stars */}
                    <div className="kh-star s1" />
                    <div className="kh-star s2" />
                    <div className="kh-star s3" />
                    <div className="kh-star s4" />
                    <div className="kh-star s5" />
                    <div className="kh-star s6" />
                    <div className="kh-star s7" />
                    <div className="kh-star s8" />
                    <div className="kh-star s9" />
                    <div className="kh-star s10" />
                    <div className="kh-star s11" />
                    <div className="kh-star s12" />

                    {/* Crystal Heart — glowing above */}
                    <div className="kh-heart-container">
                      <svg viewBox="0 0 48 48" width="48" height="48" className="kh-heart-crystal">
                        {/* Heart shape built from crystal facets */}
                        {/* Left top lobe */}
                        <polygon points="24,18 12,8 6,16" fill="rgba(255,120,150,0.7)" />
                        <polygon points="24,18 6,16 10,26" fill="rgba(255,80,120,0.5)" />
                        <polygon points="12,8 6,16 4,10" fill="rgba(255,160,180,0.6)" />
                        {/* Right top lobe */}
                        <polygon points="24,18 36,8 42,16" fill="rgba(255,140,165,0.65)" />
                        <polygon points="24,18 42,16 38,26" fill="rgba(255,90,130,0.45)" />
                        <polygon points="36,8 42,16 44,10" fill="rgba(255,170,190,0.55)" />
                        {/* Center / bottom point */}
                        <polygon points="10,26 24,18 24,44" fill="rgba(255,60,100,0.5)" />
                        <polygon points="38,26 24,18 24,44" fill="rgba(255,100,140,0.55)" />
                        <polygon points="10,26 38,26 24,44" fill="rgba(255,50,90,0.35)" />
                        {/* Bright center highlight */}
                        <polygon points="24,18 18,22 24,32" fill="rgba(255,200,220,0.5)" />
                        <polygon points="24,18 30,22 24,32" fill="rgba(255,180,200,0.4)" />
                        {/* Edge lines */}
                        <line x1="12" y1="8" x2="24" y2="18" stroke="rgba(255,200,220,0.5)" strokeWidth="0.5"/>
                        <line x1="36" y1="8" x2="24" y2="18" stroke="rgba(255,200,220,0.5)" strokeWidth="0.5"/>
                        <line x1="10" y1="26" x2="24" y2="44" stroke="rgba(255,150,180,0.3)" strokeWidth="0.5"/>
                        <line x1="38" y1="26" x2="24" y2="44" stroke="rgba(255,150,180,0.3)" strokeWidth="0.5"/>
                        <line x1="6" y1="16" x2="10" y2="26" stroke="rgba(255,180,200,0.3)" strokeWidth="0.5"/>
                        <line x1="42" y1="16" x2="38" y2="26" stroke="rgba(255,180,200,0.3)" strokeWidth="0.5"/>
                      </svg>
                      {/* Heart glow orb behind */}
                      <div className="kh-heart-glow" />
                    </div>

                    {/* Rising particles from heart */}
                    <div className="kh-heart-particle hp1" />
                    <div className="kh-heart-particle hp2" />
                    <div className="kh-heart-particle hp3" />
                    <div className="kh-heart-particle hp4" />

                    {/* Character — lying on back, floating in void */}
                    <svg viewBox="0 0 120 40" width="120" height="40" className="kh-character">
                      {/* Head */}
                      <circle cx="18" cy="18" r="8" fill="none" stroke="#7c8aaa" strokeWidth="1.8"/>
                      {/* Closed eyes — peaceful */}
                      <path d="M13 17 Q15 19 17 17" fill="none" stroke="#7c8aaa" strokeWidth="0.8" strokeLinecap="round"/>
                      <path d="M19 17 Q21 19 23 17" fill="none" stroke="#7c8aaa" strokeWidth="0.8" strokeLinecap="round"/>
                      {/* Spiky hair */}
                      <line x1="10" y1="12" x2="5" y2="6" stroke="#7c8aaa" strokeWidth="1.5" strokeLinecap="round"/>
                      <line x1="13" y1="10" x2="9" y2="3" stroke="#7c8aaa" strokeWidth="1.5" strokeLinecap="round"/>
                      <line x1="17" y1="10" x2="15" y2="2" stroke="#7c8aaa" strokeWidth="1.2" strokeLinecap="round"/>
                      <line x1="21" y1="11" x2="22" y2="5" stroke="#7c8aaa" strokeWidth="1" strokeLinecap="round"/>
                      {/* Body — lying flat on back */}
                      <line x1="26" y1="18" x2="65" y2="20" stroke="#7c8aaa" strokeWidth="1.8" strokeLinecap="round"/>
                      {/* Arms — draped down */}
                      <line x1="36" y1="19" x2="30" y2="28" stroke="#7c8aaa" strokeWidth="1.8" strokeLinecap="round"/>
                      <line x1="30" y1="28" x2="26" y2="34" stroke="#7c8aaa" strokeWidth="1.5" strokeLinecap="round"/>
                      <line x1="50" y1="19" x2="55" y2="30" stroke="#7c8aaa" strokeWidth="1.8" strokeLinecap="round"/>
                      <line x1="55" y1="30" x2="58" y2="35" stroke="#7c8aaa" strokeWidth="1.5" strokeLinecap="round"/>
                      {/* Legs */}
                      <line x1="65" y1="20" x2="82" y2="22" stroke="#7c8aaa" strokeWidth="1.8" strokeLinecap="round"/>
                      <line x1="82" y1="22" x2="92" y2="18" stroke="#7c8aaa" strokeWidth="1.5" strokeLinecap="round"/>
                      <line x1="65" y1="20" x2="80" y2="26" stroke="#7c8aaa" strokeWidth="1.8" strokeLinecap="round"/>
                      <line x1="80" y1="26" x2="90" y2="24" stroke="#7c8aaa" strokeWidth="1.5" strokeLinecap="round"/>
                      {/* Big shoes */}
                      <ellipse cx="95" cy="17" rx="5" ry="3" fill="none" stroke="#7c8aaa" strokeWidth="1.2"/>
                      <ellipse cx="93" cy="24" rx="5" ry="3" fill="none" stroke="#7c8aaa" strokeWidth="1.2"/>
                    </svg>

                    {/* Subtle purple floor glow under character */}
                    <div className="kh-floor-glow" />
                  </div>

                  {/* Continue button */}
                  {gameMode !== 'daily' ? (
                    <button 
                      onClick={() => startGame(targetGame, gameMode, archiveDate)}
                      className="kh-continue-btn mt-2"
                    >
                      Continue?
                    </button>
                  ) : (
                    <div className="kh-continue-text mt-2">
                      See you tomorrow!
                    </div>
                  )}
                </div>
              )}              
              {/* Target game attributes */}
              <div className="mt-4 grid grid-cols-3 gap-1.5 sm:gap-2 max-w-sm mx-auto">
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Year</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.year}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Art Style</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.artStyle}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Original System</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.platform}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Protagonist</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.protagonistType}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Setting</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.setting}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Primary Genre</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.primaryGenre}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Genres</span>
                  <div className="flex flex-wrap justify-center gap-0.5 sm:gap-1 mt-0.5">
                    {targetGame.genres?.slice(0,3)?.map((g, i) => (
                      <span key={i} className="inline-block px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[12px] font-bold bg-emerald-600/50 text-white">{g}</span>
                    ))}
                  </div>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Publisher</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.publisher}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Perspective</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.perspective}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Franchise</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.franchise || 'None'}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Gender</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.protagonistGender}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center overflow-hidden">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Multiplayer</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">{targetGame.isMultiplayer ? 'Yes' : 'No'}</span>
                </div>
                <div className="bg-emerald-500 p-1.5 sm:p-2 rounded-lg text-center col-span-3">
                  <span className="text-white/60 text-[9px] sm:text-[11px] block">Rank</span>
                  <span className="text-white font-bold text-[10px] sm:text-[15px] leading-tight break-words w-full">#{targetGame.popularityRank}</span>
                </div>
              </div>


            </div>
          </div>
        )}

        {/* Guesses Grid */}
        <div className="space-y-9">
          {[...guesses].reverse().map((guess, idx) => (
            <div key={idx} className="guess-row">
              <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 max-w-lg mx-auto">
                {/* Cover + Title side by side */}
                <div className="flex items-center gap-3 sm:flex-col sm:gap-1 flex-shrink-0 mx-auto sm:mx-0">
                  {guess.coverUrl && (
                    <img 
                      src={`https:${guess.coverUrl}`} 
                      alt={guess.name}
                      className={`w-16 h-20 sm:w-20 sm:h-28 object-cover rounded-xl flex-shrink-0 ${
                        guess.feedback.name === 'correct' ? 'ring-2 ring-emerald-500' : ''
                      }`}
                    />
                  )}
                  <div className={`text-sm sm:text-base font-semibold sm:text-center sm:max-w-[80px] sm:leading-tight ${
                    guess.feedback.name === 'correct' ? 'text-emerald-400' : 'text-blue-300'
                  }`}>
                    {guess.name}
                  </div>
                </div>
                
                <div className="grid grid-cols-3 gap-1.5 sm:gap-2 flex-1">
                  <FeedbackCell label="Year" value={guess.year} feedback={guess.feedback.year} />
                  <FeedbackCell label="Art Style" value={guess.artStyle} feedback={guess.feedback.artStyle} />
                  <FeedbackCell label="Original System" value={guess.platform} feedback={guess.feedback.platform} />
                  <FeedbackCell label="Protagonist" value={guess.protagonistType} feedback={guess.feedback.protagonistType} />
                  <FeedbackCell label="Setting" value={guess.setting} feedback={guess.feedback.setting} />
                  <FeedbackCell label="Primary Genre" value={guess.primaryGenre} feedback={guess.feedback.primaryGenre} />
                  <GenreCell guessGenres={guess.genres} targetGenres={targetGame.genres} feedback={guess.feedback.genres} />
                  <FeedbackCell label="Publisher" value={guess.publisher} feedback={guess.feedback.publisher} />
                  <FeedbackCell label="Perspective" value={guess.perspective} feedback={guess.feedback.perspective} />
                  <FeedbackCell label="Franchise" value={guess.franchise} feedback={guess.feedback.franchise} displayValue={guess.franchise || 'None'} />
                  <FeedbackCell label="Gender" value={guess.protagonistGender} feedback={guess.feedback.protagonistGender} />
                  <FeedbackCell label="Multiplayer" value={guess.isMultiplayer} feedback={guess.feedback.isMultiplayer} />
                  <div className="col-span-3">
                    <FeedbackCell label="Rank" value={guess.popularityRank} feedback={guess.feedback.rating} displayValue={`#${guess.popularityRank}`} />
                  </div>                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="mt-48 text-center text-blue-700 text-xs pb-4">
          {!(gameStarted || guesses.length > 0 || alreadyPlayed || gameMode !== 'daily') && (
            <div className="mb-1">{GAMES_DATABASE.length} games in database</div>
          )}
          <FeedbackForm />
        </div>
      </div>
      
      {statsModalContent}
      {menuModalContent}
      
      {/* Login Modal */}
      {showLogin && (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onAuth={() => {}}
          login={login}
          signup={signup}
        />
      )}
      
      {/* Leaderboard Modal */}
      {showLeaderboard && user && (
        <LeaderboardModal
          onClose={() => setShowLeaderboard(false)}
          user={user}
        />
      )}
      
      <Analytics />
    </div>
  );
}



export default App;

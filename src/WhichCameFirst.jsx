import { useState, useEffect, useRef, useCallback } from "react";
import GAMES_DATABASE from "./games-database.json";
import { useAuth, saveWcfScore, WcfLeaderboardModal } from "./Leaderboard";

// ─── Platform filter config ───────────────────────────────────────────────────

const PLATFORM_FILTERS = [
  { label: "All",         key: "all",         match: null },
  { label: "PlayStation", key: "playstation",  match: ["PlayStation"] },
  { label: "Xbox",        key: "xbox",         match: ["Xbox"] },
  { label: "Nintendo",    key: "nintendo",     match: ["Nintendo", "N64", "NES", "SNES", "Game Boy", "GameCube", "Wii"] },
  { label: "PC",          key: "pc",           match: ["PC", "Windows"] },
];

function buildPool(filterKey) {
  const filter = PLATFORM_FILTERS.find((f) => f.key === filterKey);
  if (!filter || !filter.match) {
    return GAMES_DATABASE.filter((g) => g.releaseDate && g.coverUrl);
  }
  return GAMES_DATABASE.filter((g) => {
    if (!g.releaseDate || !g.coverUrl) return false;
    const plat = g.platform || "";
    return filter.match.some((term) => plat.includes(term));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRandom(pool, excludeIds) {
  const available = pool.filter((g) => !excludeIds.has(g.id));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function getPair(pool, lastPair = []) {
  const excludeIds = new Set(lastPair.map((g) => g.id));
  const a = getRandom(pool, excludeIds);
  if (!a) return null;
  excludeIds.add(a.id);
  const b = getRandom(pool, excludeIds);
  if (!b) return null;
  return [a, b];
}

function formatTime(ms) {
  const totalCs = Math.floor(ms / 10);
  const cs = String(totalCs % 100).padStart(2, "0");
  const totalS = Math.floor(totalCs / 100);
  const s = String(totalS % 60).padStart(2, "0");
  const m = String(Math.floor(totalS / 60)).padStart(2, "0");
  return `${m}:${s}.${cs}`;
}

function formatDate(iso) {
  if (!iso) return "Unknown";
  const [y, mo, d] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(mo) - 1]} ${parseInt(d)}, ${y}`;
}

function bestKey(filterKey) {
  return `wcf_best_${filterKey}`;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function WhichCameFirst({ onExit }) {
  const [activeFilter, setActiveFilter] = useState("all");
  const [pool, setPool]                 = useState(() => buildPool("all"));
  const [phase, setPhase]               = useState("idle");
  const [pair, setPair]                 = useState([]);
  const [streak, setStreak]             = useState(0);
  const [bestStreak, setBest]           = useState(() => parseInt(localStorage.getItem(bestKey("all")) || "0"));
  const [elapsed, setElapsed]           = useState(0);
  const [flash, setFlash]               = useState(null);
  const [flashType, setFlashType]       = useState(null);
  const [lastEntry, setLastEntry]       = useState(null);
  const [finalTime, setFinalTime]       = useState(0);
  const [copied, setCopied]             = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const { user } = useAuth();

  const startRef  = useRef(null);
  const rafRef    = useRef(null);
  const lockRef   = useRef(false);
  const streakRef = useRef(0);

  useEffect(() => { streakRef.current = streak; }, [streak]);

  // ── Timer ──────────────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    setElapsed(Date.now() - startRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const startTimer = useCallback(() => {
    startRef.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const stopTimer = useCallback(() => cancelAnimationFrame(rafRef.current), []);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // ── Switch filter ──────────────────────────────────────────────────────────
  function switchFilter(key) {
    setActiveFilter(key);
    setPool(buildPool(key));
    setBest(parseInt(localStorage.getItem(bestKey(key)) || "0"));
    setPhase("idle");
    setFlash(null);
    setFlashType(null);
    stopTimer();
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  function startGame() {
    const newPair = getPair(pool);
    if (!newPair) return;
    setPair(newPair);
    setStreak(0);
    streakRef.current = 0;
    setElapsed(0);
    setFlash(null);
    setFlashType(null);
    setLastEntry(null);
    lockRef.current = false;
    setPhase("playing");
    startTimer();
  }

  // ── Pick ───────────────────────────────────────────────────────────────────
  function handlePick(side) {
    if (phase !== "playing" || lockRef.current) return;
    lockRef.current = true;

    const [a, b] = pair;
    const correct = side === "left"
      ? a.releaseDate <= b.releaseDate
      : b.releaseDate <= a.releaseDate;

    setFlash(side);
    setFlashType(correct ? "correct" : "wrong");

    if (correct) {
      setTimeout(() => {
        const newPair = getPair(pool, pair);
        if (!newPair) return;
        setPair(newPair);
        setFlash(null);
        setFlashType(null);
        setStreak((s) => {
          const next = s + 1;
          setBest((best) => {
            if (next > best) {
              localStorage.setItem(bestKey(activeFilter), String(next));
              return next;
            }
            return best;
          });
          return next;
        });
        lockRef.current = false;
      }, 300);
    } else {
      stopTimer();
      const t = Date.now() - startRef.current;
      setFinalTime(t);
      setLastEntry({ a, b, chosenSide: side });
      setBest((best) => {
        const cur = streakRef.current;
        if (cur > best) {
          localStorage.setItem(bestKey(activeFilter), String(cur));
          return cur;
        }
        return best;
      });
      if (user) {
        saveWcfScore(user.id, user.username, streakRef.current, t, activeFilter);
      }
      setTimeout(() => setPhase("dead"), 500);
    }
  }

  function copyShare() {
    const filterLabel = PLATFORM_FILTERS.find((f) => f.key === activeFilter)?.label || "All";
    const txt = `🎮 Which Came First? (${filterLabel})\n🔥 Streak: ${streak}\n⏱️ Time: ${formatTime(finalTime)}\n\nmetaguess.io`;
    navigator.clipboard.writeText(txt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  // ─── Platform filter tabs ─────────────────────────────────────────────────
  const FilterTabs = () => (
    <div className="flex gap-2 flex-wrap justify-center mb-6">
      {PLATFORM_FILTERS.map((f) => (
        <button
          key={f.key}
          onClick={() => switchFilter(f.key)}
          style={{ touchAction: 'manipulation', minHeight: 44 }}
          className={`px-3 py-2 rounded-lg text-xs font-bold tracking-widest transition-all ${
            activeFilter === f.key
              ? "ps2-btn text-white"
              : "border border-blue-900/50 text-blue-600 hover:text-blue-400 hover:border-blue-700"
          }`}
        >
          {f.label.toUpperCase()}
        </button>
      ))}
    </div>
  );

  // ─── IDLE ──────────────────────────────────────────────────────────────────
  if (phase === "idle") {
    return (
      <>
      <div className="ps2-bg text-white flex flex-col items-center justify-center px-4"
        style={{ minHeight: '100dvh' }}>
        <style>{`
          @keyframes wcf-flicker { 0%,100%{opacity:1} 92%{opacity:1} 93%{opacity:.8} 94%{opacity:1} }
          .wcf-flicker { animation: wcf-flicker 4s infinite; }
          .wcf-tap { touch-action: manipulation; }
        `}</style>

        <div className="text-center w-full max-w-sm">
          <p className="text-[10px] tracking-[6px] text-blue-600 mb-5">METAGUESS · BONUS MODE</p>

          <h1 className="text-6xl sm:text-8xl font-extrabold leading-none tracking-tight ps2-title wcf-flicker mb-7">
            WHICH<br />CAME<br />FIRST?
          </h1>

          <FilterTabs />

          <button
            onClick={startGame}
            style={{ touchAction: 'manipulation', minHeight: 52 }}
            className="wcf-tap w-full py-4 ps2-btn text-white font-bold tracking-widest text-sm rounded-xl mb-3 active:opacity-75 transition-opacity"
          >
            &nbsp;PRESS START
          </button>

          <button
            onClick={() => setShowLeaderboard(true)}
            style={{ touchAction: 'manipulation', minHeight: 44 }}
            className="wcf-tap w-full py-2.5 rounded-xl font-bold tracking-widest text-sm border border-blue-700/50 text-blue-400 hover:border-blue-500 hover:text-blue-300 transition-colors mb-5"
          >
            &nbsp;LEADERBOARD
          </button>

          <button
            onClick={onExit}
            style={{ touchAction: 'manipulation', minHeight: 44 }}
            className="wcf-tap text-xs text-blue-700 active:text-blue-400 transition-colors tracking-widest py-2"
          >
            ← BACK TO METAGUESS
          </button>
        </div>
      </div>
      {showLeaderboard && (
        <WcfLeaderboardModal
          onClose={() => setShowLeaderboard(false)}
          user={user}
          filterKey={activeFilter}
        />
      )}
      </>
    );
  }

  // ─── DEAD ──────────────────────────────────────────────────────────────────
  if (phase === "dead") {
    return (
      <>
      <div className="ps2-bg text-white flex flex-col items-center justify-center px-4 py-8"
        style={{ minHeight: '100dvh' }}>
        <div className="text-center w-full max-w-md">

          <p className="text-xs tracking-[8px] text-red-500 mb-5" style={{ textShadow: '0 0 16px rgba(255,50,80,0.7)' }}>
            GAME OVER
          </p>

          {/* Stats */}
          <div className="flex items-center justify-center gap-4 ps2-modal rounded-2xl p-5 mb-5">
            <div className="flex flex-col items-center">
              <span className="text-4xl font-extrabold text-blue-300">{streak}</span>
              <span className="text-[9px] tracking-[3px] text-blue-600 mt-1">STREAK</span>
            </div>
            <div className="w-px h-10 bg-blue-900" />
            <div className="flex flex-col items-center">
              <span className="text-xl font-extrabold font-mono text-green-400" style={{ textShadow: '0 0 10px rgba(0,255,136,0.5)' }}>
                {formatTime(finalTime)}
              </span>
              <span className="text-[9px] tracking-[3px] text-blue-600 mt-1">TIME</span>
            </div>
            <div className="w-px h-10 bg-blue-900" />
            <div className="flex flex-col items-center">
              <span className="text-4xl font-extrabold text-blue-300">{bestStreak}</span>
              <span className="text-[9px] tracking-[3px] text-blue-600 mt-1">BEST</span>
            </div>
          </div>

          {/* Killer pair */}
          {lastEntry && (() => {
            const { a, b, chosenSide } = lastEntry;
            const aWasFirst = a.releaseDate <= b.releaseDate;
            return (
              <div className="mb-5">
                <div className="flex gap-3 justify-center items-center">
                  <MiniCard game={a} date={a.releaseDate} picked={chosenSide === "left"} isCorrect={aWasFirst} />
                  <div className="text-blue-800 text-sm font-bold tracking-widest flex-shrink-0">VS</div>
                  <MiniCard game={b} date={b.releaseDate} picked={chosenSide === "right"} isCorrect={!aWasFirst} />
                </div>
              </div>
            );
          })()}

          <div className="flex gap-3 mb-4">
            <button
              onClick={startGame}
              style={{ touchAction: 'manipulation', minHeight: 52 }}
              className="flex-1 py-3 ps2-btn text-white font-bold tracking-widest text-sm rounded-xl active:opacity-75 transition-opacity"
            >
              ↺ PLAY AGAIN
            </button>
            <button
              onClick={copyShare}
              style={{ touchAction: 'manipulation', minHeight: 52 }}
              className="flex-1 py-3 rounded-xl font-bold tracking-widest text-sm border border-green-500/50 text-green-400 active:bg-green-500/10 transition-colors"
            >
              {copied ? "✓ COPIED!" : "⎘ SHARE"}
            </button>
          </div>

          <button
            onClick={() => setShowLeaderboard(true)}
            style={{ touchAction: 'manipulation', minHeight: 44 }}
            className="wcf-tap w-full py-2.5 rounded-xl font-bold tracking-widest text-sm border border-blue-700/50 text-blue-400 hover:border-blue-500 hover:text-blue-300 transition-colors mb-3"
          >
            🏆 &nbsp;LEADERBOARD {!user && <span className="text-blue-600 text-[10px] ml-1">(log in to submit)</span>}
          </button>

          <button
            onClick={() => { stopTimer(); setPhase("idle"); }}
            style={{ touchAction: 'manipulation', minHeight: 44 }}
            className="text-xs text-blue-700 active:text-blue-400 transition-colors tracking-widest block mx-auto mb-2 py-2"
          >
            ↺ CHANGE PLATFORM
          </button>
          <button
            onClick={onExit}
            style={{ touchAction: 'manipulation', minHeight: 44 }}
            className="text-xs text-blue-800 active:text-blue-500 transition-colors tracking-widest py-2"
          >
            ← BACK TO METAGUESS
          </button>
        </div>
      </div>
      {showLeaderboard && (
        <WcfLeaderboardModal
          onClose={() => setShowLeaderboard(false)}
          user={user}
          filterKey={activeFilter}
        />
      )}
      </>
    );
  }

  // ─── PLAYING ───────────────────────────────────────────────────────────────
  const [a, b] = pair;
  const filterLabel = PLATFORM_FILTERS.find((f) => f.key === activeFilter)?.label;

  return (
    <div className="ps2-bg text-white flex flex-col items-center" style={{ minHeight: '100dvh' }}>
      <style>{`
        .wcf-card { transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
        .wcf-card:active { transform: scale(0.97); }
        .wcf-card.flash-correct { border-color: #00ff88 !important; box-shadow: 0 0 28px rgba(0,255,136,0.45); transform: scale(1.02); }
        .wcf-card.flash-wrong   { border-color: #ff3355 !important; box-shadow: 0 0 28px rgba(255,51,85,0.45);  transform: scale(1.02); }
      `}</style>

      {/* HUD */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 w-full max-w-lg">
        <div className="flex flex-col items-center w-14">
          <span className="text-2xl font-extrabold text-blue-300">{streak}</span>
          <span className="text-[8px] tracking-[3px] text-blue-700">STREAK</span>
        </div>

        <div className="ps2-modal rounded-xl px-5 py-2 text-center">
          <div className="text-2xl font-extrabold font-mono tracking-wider" style={{ color: '#00ff88', textShadow: '0 0 12px rgba(0,255,136,0.6)' }}>
            {formatTime(elapsed)}
          </div>
          {activeFilter !== "all" && (
            <div className="text-[8px] tracking-[3px] text-blue-700 mt-0.5">{filterLabel.toUpperCase()}</div>
          )}
        </div>

        <div className="flex flex-col items-center w-14">
          <span className="text-2xl font-extrabold text-blue-300">{bestStreak}</span>
          <span className="text-[8px] tracking-[3px] text-blue-700">BEST</span>
        </div>
      </div>

      {/* Cards — natural size, centered */}
      <div className="flex gap-3 px-3 w-full max-w-lg items-center">
        <GameCard game={a} flashClass={flash === "left"  ? `flash-${flashType}` : ""} onClick={() => handlePick("left")}  />
        <div className="flex-shrink-0 text-blue-800 font-extrabold text-sm tracking-widest">VS</div>
        <GameCard game={b} flashClass={flash === "right" ? `flash-${flashType}` : ""} onClick={() => handlePick("right")} />
      </div>

      {/* Exit */}
      <div className="text-center py-4 mt-2">
        <button
          onClick={onExit}
          style={{ touchAction: 'manipulation', minHeight: 36 }}
          className="text-[9px] tracking-[4px] text-blue-800 active:text-blue-500 transition-colors"
        >
          ← BACK TO METAGUESS
        </button>
      </div>
    </div>
  );
}

// ─── GameCard ────────────────────────────────────────────────────────────────

function GameCard({ game, flashClass, onClick }) {
  return (
    <div
      className={`wcf-card flex-1 rounded-xl overflow-hidden border-2 border-transparent cursor-pointer select-none ${flashClass}`}
      style={{ background: '#0a0a1f', WebkitTapHighlightColor: 'transparent' }}
      onClick={onClick}
    >
      <img
        src={`https:${game.coverUrl}`}
        alt={game.name}
        className="w-full object-contain"
        style={{ display: 'block', aspectRatio: '3/4', background: '#0a0a1f' }}
        draggable={false}
      />
      <div className="p-2 border-t border-blue-900/40">
        <p className="text-xs font-bold text-blue-100 leading-snug"
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {game.name}
        </p>
      </div>
    </div>
  );
}

// ─── MiniCard (game-over recap) ───────────────────────────────────────────────

function MiniCard({ game, date, picked, isCorrect }) {
  const border = picked
    ? isCorrect ? 'border-green-500' : 'border-red-500'
    : 'border-blue-900/40';
  const dateColor = isCorrect ? 'text-green-400' : 'text-red-400';

  return (
    <div className={`flex-1 max-w-[48%] rounded-xl overflow-hidden border-2 ${border}`} style={{ background: '#0a0a1f' }}>
      <img src={`https:${game.coverUrl}`} alt={game.name} className="w-full object-cover" style={{ aspectRatio: '3/4', display: 'block' }} />
      <div className="p-2">
        <p className="text-[10px] font-bold text-blue-100 leading-snug"
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {game.name}
        </p>
        <p className={`text-[9px] mt-0.5 font-mono ${dateColor}`}>{formatDate(date)}</p>
      </div>
    </div>
  );
}

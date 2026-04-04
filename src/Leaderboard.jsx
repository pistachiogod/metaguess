import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

// ==================== AUTH HOOK ====================
export function useAuth() {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('metaguess-user');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });

  const login = async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setUser(data.user);
    localStorage.setItem('metaguess-user', JSON.stringify(data.user));
    return data.user;
  };

  const signup = async (username, password) => {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setUser(data.user);
    localStorage.setItem('metaguess-user', JSON.stringify(data.user));
    return data.user;
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem('metaguess-user');
  };

  return { user, login, signup, logout };
}

// ==================== SAVE SCORE ====================
export async function saveScore(userId, gameDate, gameNumber, won, numGuesses, guessIds = []) {
  const { error } = await supabase
    .from('daily_scores')
    .upsert({
      user_id: userId,
      game_date: gameDate,
      game_number: gameNumber,
      won,
      num_guesses: numGuesses,
      guess_ids: guessIds,
    }, { onConflict: 'user_id,game_date' });
  
  if (error) console.error('Error saving score:', error);
  return !error;
}

// ==================== FETCH CLOUD STATS ====================
export async function fetchCloudStats(userId) {
  const { data, error } = await supabase
    .from('daily_scores')
    .select('game_date, won, num_guesses, guess_ids')
    .eq('user_id', userId)
    .order('game_date', { ascending: true });

  if (error || !data) return null;

  // Rebuild stats from cloud data
  let gamesPlayed = data.length;
  let gamesWon = 0;
  let currentStreak = 0;
  let maxStreak = 0;
  let tempStreak = 0;
  const guessDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 };

  data.forEach(score => {
    if (score.won) {
      gamesWon++;
      tempStreak++;
      if (tempStreak > maxStreak) maxStreak = tempStreak;
      if (score.num_guesses >= 1 && score.num_guesses <= 10) {
        guessDistribution[score.num_guesses]++;
      }
    } else {
      tempStreak = 0;
    }
  });

  // Current streak = count backwards from most recent
  currentStreak = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i].won) currentStreak++;
    else break;
  }

  return {
    gamesPlayed,
    gamesWon,
    currentStreak,
    maxStreak,
    guessDistribution,
    lastPlayedDate: data.length > 0 ? data[data.length - 1].game_date : null,
  };
}

// ==================== CHECK IF TODAY ALREADY PLAYED ====================
export async function checkTodayPlayed(userId, gameDate) {
  const { data, error } = await supabase
    .from('daily_scores')
    .select('won, num_guesses, guess_ids')
    .eq('user_id', userId)
    .eq('game_date', gameDate)
    .single();

  if (error || !data) return null;
  return data; // { won, num_guesses, guess_ids }
}

// ==================== WCF HELPERS ====================
function formatWcfTime(ms) {
  const totalCs = Math.floor(ms / 10);
  const cs = String(totalCs % 100).padStart(2, "0");
  const totalS = Math.floor(totalCs / 100);
  const s = String(totalS % 60).padStart(2, "0");
  const m = String(Math.floor(totalS / 60)).padStart(2, "0");
  return `${m}:${s}.${cs}`;
}

// ==================== SAVE WCF SCORE ====================
export async function saveWcfScore(userId, username, streak, timeMs, filterKey = 'all') {
  // Fetch existing best for this user + filter
  const { data: existing } = await supabase
    .from('wcf_scores')
    .select('id, streak, time_ms')
    .eq('user_id', userId)
    .eq('filter_key', filterKey)
    .maybeSingle();

  if (existing) {
    // Only update if strictly better: higher streak, or same streak with faster time
    const isBetter = streak > existing.streak || (streak === existing.streak && timeMs < existing.time_ms);
    if (!isBetter) return false;
    const { error } = await supabase
      .from('wcf_scores')
      .update({ streak, time_ms: timeMs, username, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) console.error('Error updating WCF score:', error);
    return !error;
  }

  // Insert new record
  const { error } = await supabase
    .from('wcf_scores')
    .insert({ user_id: userId, username, streak, time_ms: timeMs, filter_key: filterKey });
  if (error) console.error('Error saving WCF score:', error);
  return !error;
}

// ==================== FETCH WCF LEADERBOARD ====================
export async function fetchWcfLeaderboard(filterKey = 'all') {
  const { data, error } = await supabase
    .from('wcf_scores')
    .select('user_id, username, streak, time_ms')
    .eq('filter_key', filterKey)
    .order('streak', { ascending: false })
    .order('time_ms', { ascending: true })
    .limit(50);

  if (error || !data) return [];
  return data;
}

// ==================== WCF LEADERBOARD MODAL ====================
export function WcfLeaderboardModal({ onClose, user, filterKey = 'all' }) {
  const [tab, setTab] = useState('streak');
  const [scores, setScores] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const data = await fetchWcfLeaderboard(filterKey);
      setScores(data);
      setLoading(false);
    };
    load();
  }, [filterKey]);

  const streakRanked = [...scores].sort((a, b) => b.streak - a.streak || a.time_ms - b.time_ms);
  const timeRanked = [...scores].filter(s => s.streak >= 5).sort((a, b) => a.time_ms - b.time_ms || b.streak - a.streak);
  const rows = tab === 'streak' ? streakRanked : timeRanked;

  const FILTER_LABELS = { all: 'All', playstation: 'PlayStation', xbox: 'Xbox', nintendo: 'Nintendo', pc: 'PC' };

  return (
    <div className="fixed inset-0 ps2-modal-bg flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="ps2-modal rounded-2xl p-4 sm:p-5 max-w-sm w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-1">
          <h2 className="text-lg font-bold text-white">WCF Leaderboard</h2>
          <button onClick={onClose} className="text-blue-400 hover:text-white text-xl">✕</button>
        </div>
        <p className="text-[10px] tracking-widest text-blue-600 mb-3">{FILTER_LABELS[filterKey]?.toUpperCase() || 'ALL'} PLATFORM</p>

        {/* Tabs */}
        <div className="flex gap-1 mb-3 bg-[#0a0a1a] rounded-lg p-1">
          <button
            onClick={() => setTab('streak')}
            className={`flex-1 py-1.5 text-[10px] sm:text-xs font-semibold rounded-md transition-colors ${tab === 'streak' ? 'bg-blue-600 text-white' : 'text-blue-400 hover:text-blue-200'}`}
          >
            🔥 Best Streak
          </button>
          <button
            onClick={() => setTab('time')}
            className={`flex-1 py-1.5 text-[10px] sm:text-xs font-semibold rounded-md transition-colors ${tab === 'time' ? 'bg-blue-600 text-white' : 'text-blue-400 hover:text-blue-200'}`}
          >
            ⚡ Fastest (5+ streak)
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="text-center text-blue-400 py-8">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="text-center text-blue-500 py-8 text-sm">
              {tab === 'time' ? 'No scores with 5+ streak yet!' : 'No scores yet — be the first!'}
            </div>
          ) : (
            <div className="space-y-1.5">
              {rows.map((entry, idx) => {
                const isMe = user && entry.user_id === user.id;
                const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null;
                return (
                  <div
                    key={`${entry.user_id}-${idx}`}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl ${isMe ? 'bg-blue-900/40 border border-blue-600/40' : 'bg-[#0d0d1a]'}`}
                  >
                    <span className={`text-sm font-bold w-6 text-center flex-shrink-0 ${!medal ? 'text-blue-700' : ''}`}>
                      {medal || `${idx + 1}`}
                    </span>
                    <span className={`flex-1 text-sm font-medium truncate ${isMe ? 'text-blue-200' : 'text-white'}`}>
                      {entry.username}{isMe ? ' (you)' : ''}
                    </span>
                    <div className="text-right flex-shrink-0">
                      <div className="text-xs font-bold text-blue-300">{entry.streak} streak</div>
                      <div className="text-[10px] font-mono text-green-400">{formatWcfTime(entry.time_ms)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {!user && (
          <p className="text-center text-blue-600 text-[10px] tracking-wider mt-3 pt-3 border-t border-blue-900/30">
            Log in to submit your scores
          </p>
        )}
      </div>
    </div>
  );
}
export function LoginModal({ onClose, onAuth, login, signup }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError('');
    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords don\'t match');
      return;
    }
    setLoading(true);
    try {
      const fn = mode === 'login' ? login : signup;
      const user = await fn(username, password);
      onAuth(user);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit();
  };

  return (
    <div className="fixed inset-0 ps2-modal-bg flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="ps2-modal rounded-2xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-white">
            {mode === 'login' ? 'Log In' : 'Create Account'}
          </h2>
          <button onClick={onClose} className="text-blue-400 hover:text-white text-xl">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-blue-400 text-xs font-medium block mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={mode === 'signup' ? 'pick a username' : 'username'}
              className="ps2-input w-full rounded-lg px-3 py-2.5 text-base sm:text-sm text-blue-100 placeholder-blue-600"
              autoFocus
            />
          </div>
          <div>
            <label className="text-blue-400 text-xs font-medium block mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={mode === 'signup' ? 'pick a password' : 'password'}
              className="ps2-input w-full rounded-lg px-3 py-2.5 text-base sm:text-sm text-blue-100 placeholder-blue-600"
            />
          </div>

          {mode === 'signup' && (
            <div>
              <label className="text-blue-400 text-xs font-medium block mb-1">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="type it again"
                className="ps2-input w-full rounded-lg px-3 py-2.5 text-base sm:text-sm text-blue-100 placeholder-blue-600"
              />
              {confirmPassword && password !== confirmPassword && (
                <div className="text-red-400 text-[11px] mt-1">Passwords don't match</div>
              )}
              {confirmPassword && password && password === confirmPassword && (
                <div className="text-emerald-400 text-[11px] mt-1">✓ Passwords match</div>
              )}
            </div>
          )}

          {error && (
            <div className="text-red-400 text-sm bg-red-500/10 rounded-lg px-3 py-2">{error}</div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading || !username || !password || (mode === 'signup' && password !== confirmPassword)}
            className="w-full py-2.5 ps2-btn text-white rounded-lg text-sm font-semibold disabled:opacity-40"
          >
            {loading ? '...' : mode === 'login' ? 'Log In' : 'Sign Up'}
          </button>

          <div className="text-center">
            <button
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setConfirmPassword(''); }}
              className="text-blue-500 text-xs hover:text-blue-300 transition-colors"
            >
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
            </button>
          </div>

          {mode === 'signup' && (
            <div className="text-blue-500/60 text-[10px] text-center mt-1 leading-tight">
              ⚠️ We don't store any personal data — just a username and password. There's no way to recover your account if you forget your password, so pick something memorable!
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== LEADERBOARD MODAL ====================
export function LeaderboardModal({ onClose, user }) {
  const [tab, setTab] = useState('global');
  const [friendsTab, setFriendsTab] = useState('list');
  const [friendScores, setFriendScores] = useState([]);
  const [globalPlayers, setGlobalPlayers] = useState([]);
  const [friends, setFriends] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState(null);
  const [loading, setLoading] = useState(true);

  // Get today's date key
  const getTodayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };

  // Load global all-time leaderboard
  const loadGlobalLeaderboard = async () => {
    const { data } = await supabase
      .from('daily_scores')
      .select('user_id, won, num_guesses');

    if (!data) return;

    // Aggregate stats per user
    const statsMap = {};
    data.forEach(s => {
      if (!statsMap[s.user_id]) statsMap[s.user_id] = { played: 0, won: 0, totalGuesses: 0 };
      statsMap[s.user_id].played++;
      if (s.won) {
        statsMap[s.user_id].won++;
        statsMap[s.user_id].totalGuesses += s.num_guesses;
      }
    });

    // Get usernames for all users with scores
    const userIds = Object.keys(statsMap);
    if (userIds.length === 0) { setGlobalPlayers([]); return; }

    const { data: users } = await supabase
      .from('users')
      .select('id, username')
      .in('id', userIds);

    if (!users) return;

    const leaderboard = users.map(u => {
      const s = statsMap[u.id];
      return {
        id: u.id,
        username: u.username,
        isYou: u.id === user.id,
        played: s.played,
        won: s.won,
        winRate: s.played > 0 ? Math.round((s.won / s.played) * 100) : 0,
        avgGuesses: s.won > 0 ? (s.totalGuesses / s.won).toFixed(1) : '—',
      };
    });

    // Sort by: best win rate, then lowest avg guesses as tiebreaker
    leaderboard.sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (a.avgGuesses === '—') return 1;
      if (b.avgGuesses === '—') return -1;
      return parseFloat(a.avgGuesses) - parseFloat(b.avgGuesses);
    });

    setGlobalPlayers(leaderboard);
  };

  // Load friends list
  const loadFriends = async () => {
    const { data: sent } = await supabase
      .from('friendships')
      .select('id, status, addressee_id, addressee:users!friendships_addressee_id_fkey(id, username)')
      .eq('requester_id', user.id)
      .eq('status', 'accepted');

    const { data: received } = await supabase
      .from('friendships')
      .select('id, status, requester_id, requester:users!friendships_requester_id_fkey(id, username)')
      .eq('addressee_id', user.id)
      .eq('status', 'accepted');

    const friendList = [
      ...(sent || []).map(f => ({ friendshipId: f.id, ...f.addressee })),
      ...(received || []).map(f => ({ friendshipId: f.id, ...f.requester })),
    ];
    setFriends(friendList);
    return friendList;
  };

  // Load pending friend requests (received)
  const loadPendingRequests = async () => {
    const { data } = await supabase
      .from('friendships')
      .select('id, requester:users!friendships_requester_id_fkey(id, username)')
      .eq('addressee_id', user.id)
      .eq('status', 'pending');
    setPendingRequests(data || []);
  };

  // Load today's scores for friends
  const loadFriendScores = async (friendList) => {
    const today = getTodayKey();
    const ids = [user.id, ...friendList.map(f => f.id)];

    const { data: todayData } = await supabase
      .from('daily_scores')
      .select('user_id, won, num_guesses, game_date')
      .eq('game_date', today)
      .in('user_id', ids);

    const { data: allData } = await supabase
      .from('daily_scores')
      .select('user_id, won, num_guesses')
      .in('user_id', ids);

    // Build per-user stats
    const statsMap = {};
    (allData || []).forEach(s => {
      if (!statsMap[s.user_id]) statsMap[s.user_id] = { played: 0, won: 0, totalGuesses: 0 };
      statsMap[s.user_id].played++;
      if (s.won) {
        statsMap[s.user_id].won++;
        statsMap[s.user_id].totalGuesses += s.num_guesses;
      }
    });

    // Map today's scores
    const scoreMap = {};
    (todayData || []).forEach(s => { scoreMap[s.user_id] = s; });

    const leaderboard = [
      { id: user.id, username: user.username, isYou: true, score: scoreMap[user.id] || null, stats: statsMap[user.id] },
      ...friendList.map(f => ({
        id: f.id, username: f.username, isYou: false, score: scoreMap[f.id] || null, stats: statsMap[f.id],
      })),
    ];

    leaderboard.sort((a, b) => {
      if (a.score?.won && !b.score?.won) return -1;
      if (!a.score?.won && b.score?.won) return 1;
      if (a.score?.won && b.score?.won) return a.score.num_guesses - b.score.num_guesses;
      if (a.score && !b.score) return -1;
      if (!a.score && b.score) return 1;
      return 0;
    });

    setFriendScores(leaderboard);
  };

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await loadGlobalLeaderboard();
      const friendList = await loadFriends();
      await loadPendingRequests();
      await loadFriendScores(friendList);
      setLoading(false);
    };
    init();
  }, []);

  // Search users
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setHasSearched(false);
    setFeedbackMsg(null);
    const { data } = await supabase
      .from('users')
      .select('id, username')
      .ilike('username', `%${searchQuery.trim().toLowerCase()}%`)
      .neq('id', user.id)
      .limit(10);
    setSearchResults(data || []);
    setHasSearched(true);
    setSearchLoading(false);
  };

  // Show a temporary feedback message
  const showFeedback = (msg, type = 'success') => {
    setFeedbackMsg({ msg, type });
    setTimeout(() => setFeedbackMsg(null), 3000);
  };

  // Send friend request
  const sendRequest = async (friendId, friendUsername) => {
    const { data: existing } = await supabase
      .from('friendships')
      .select('id')
      .or(`and(requester_id.eq.${user.id},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${user.id})`);

    if (existing && existing.length > 0) {
      showFeedback('Friend request already exists!', 'warn');
      return;
    }

    const { error } = await supabase
      .from('friendships')
      .insert({ requester_id: user.id, addressee_id: friendId });

    if (error) {
      showFeedback('Something went wrong, try again', 'error');
      return;
    }
    
    setSearchResults(prev => prev.map(u => 
      u.id === friendId ? { ...u, requestSent: true } : u
    ));
    showFeedback(`Request sent to ${friendUsername}!`, 'success');
  };

  // Accept friend request
  const acceptRequest = async (friendshipId, friendUsername) => {
    await supabase
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('id', friendshipId);
    
    const fl = await loadFriends();
    await loadFriendScores(fl);
    await loadPendingRequests();
    showFeedback(`You and ${friendUsername} are now friends!`, 'success');
  };

  // Decline friend request
  const declineRequest = async (friendshipId) => {
    await supabase
      .from('friendships')
      .delete()
      .eq('id', friendshipId);
    await loadPendingRequests();
    showFeedback('Request declined', 'warn');
  };

  // Remove friend
  const removeFriend = async (friendshipId) => {
    await supabase
      .from('friendships')
      .delete()
      .eq('id', friendshipId);
    const fl = await loadFriends();
    await loadFriendScores(fl);
  };

  const getWinRate = (s) => {
    if (!s || s.played === 0) return '—';
    return `${Math.round((s.won / s.played) * 100)}%`;
  };

  const getAvgGuesses = (s) => {
    if (!s || s.won === 0) return '—';
    return (s.totalGuesses / s.won).toFixed(1);
  };

  // Render a player row
  const PlayerRow = ({ entry, idx, showTodayScore = false }) => (
    <div
      className={`flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-xl ${
        entry.isYou ? 'bg-blue-900/30 border border-blue-700/30' : 'bg-[#0d0d1a]'
      }`}
    >
      <div className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[10px] sm:text-xs font-bold flex-shrink-0 ${
        idx === 0 ? 'bg-amber-500 text-black' :
        idx === 1 ? 'bg-zinc-400 text-black' :
        idx === 2 ? 'bg-amber-700 text-white' :
        'bg-zinc-700 text-zinc-300'
      }`}>
        {idx + 1}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-white text-xs sm:text-sm font-medium truncate">
          {entry.username} {entry.isYou && <span className="text-blue-400 text-[10px] sm:text-xs">(you)</span>}
        </div>
        {showTodayScore ? (
          <div className="text-blue-500 text-[9px] sm:text-[10px]">
            Win rate: {getWinRate(entry.stats)} · Avg: {getAvgGuesses(entry.stats)}
          </div>
        ) : (
          <div className="text-blue-500 text-[9px] sm:text-[10px]">
            {entry.won} {entry.won === 1 ? 'win' : 'wins'} · {entry.winRate}% · Avg: {entry.avgGuesses}
          </div>
        )}
      </div>

      <div className="text-right flex-shrink-0">
        {showTodayScore ? (
          entry.score ? (
            entry.score.won ? (
              <div className="bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded-lg text-xs sm:text-sm font-bold">
                {entry.score.num_guesses} 🎮
              </div>
            ) : (
              <div className="bg-red-500/20 text-red-400 px-2 py-1 rounded-lg text-[10px] sm:text-xs font-medium">
                Failed
              </div>
            )
          ) : (
            <div className="text-zinc-500 text-[10px] sm:text-xs">Not played</div>
          )
        ) : (
          <div className="text-emerald-400 text-xs sm:text-sm font-bold">{entry.won}W</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 ps2-modal-bg flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="ps2-modal rounded-2xl p-4 sm:p-5 max-w-md w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-bold text-white">Leaderboard</h2>
          <button onClick={onClose} className="text-blue-400 hover:text-white text-xl">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-3 bg-[#0a0a1a] rounded-lg p-1">
          {['global', 'friends', 'manage'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-1.5 text-[10px] sm:text-xs font-semibold rounded-md transition-colors ${
                tab === t ? 'bg-blue-600 text-white' : 'text-blue-400 hover:text-blue-200'
              }`}
            >
              {t === 'global' ? 'All Players' : t === 'friends' ? 'Friends' : 'Manage'}
              {t === 'manage' && pendingRequests.length > 0 && (
                <span className="ml-1 bg-red-500 text-white text-[8px] px-1 py-0.5 rounded-full">
                  {pendingRequests.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="text-center text-blue-400 py-8">Loading...</div>

          ) : tab === 'global' ? (
            /* GLOBAL ALL-TIME */
            <div className="space-y-1.5 sm:space-y-2">
              {globalPlayers.length === 0 ? (
                <div className="text-center text-blue-500 py-6 text-sm">
                  No players yet — be the first!
                </div>
              ) : (
                globalPlayers.map((entry, idx) => (
                  <PlayerRow key={entry.id} entry={entry} idx={idx} />
                ))
              )}
            </div>

          ) : tab === 'friends' ? (
            /* FRIENDS TODAY */
            <div className="space-y-1.5 sm:space-y-2">
              {friendScores.length <= 1 ? (
                <div className="text-center text-blue-500 py-6 text-sm">
                  Add friends to see their scores here!
                </div>
              ) : (
                friendScores.map((entry, idx) => (
                  <PlayerRow key={entry.id} entry={entry} idx={idx} showTodayScore />
                ))
              )}
            </div>

          ) : (
            /* MANAGE FRIENDS */
            <div>
              {/* Sub-tabs */}
              <div className="flex gap-1 mb-3">
                {['list', 'add', 'requests'].map(ft => (
                  <button
                    key={ft}
                    onClick={() => setFriendsTab(ft)}
                    className={`flex-1 py-1.5 text-[10px] font-semibold rounded-md transition-colors ${
                      friendsTab === ft ? 'bg-zinc-700 text-white' : 'text-blue-500 hover:text-blue-300'
                    }`}
                  >
                    {ft === 'list' ? `Friends (${friends.length})` : ft === 'add' ? 'Add Friend' : `Requests (${pendingRequests.length})`}
                  </button>
                ))}
              </div>

              {/* Feedback message */}
              {feedbackMsg && (
                <div className={`mb-3 px-3 py-2 rounded-lg text-sm text-center transition-all ${
                  feedbackMsg.type === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                  feedbackMsg.type === 'warn' ? 'bg-amber-500/20 text-amber-400' :
                  'bg-red-500/20 text-red-400'
                }`}>
                  {feedbackMsg.msg}
                </div>
              )}

              {friendsTab === 'list' && (
                <div className="space-y-2">
                  {friends.length === 0 ? (
                    <div className="text-center text-blue-500 py-6 text-sm">
                      No friends yet — add some!
                    </div>
                  ) : friends.map(f => (
                    <div key={f.id} className="flex items-center justify-between p-3 bg-[#0d0d1a] rounded-xl">
                      <span className="text-white text-sm font-medium">{f.username}</span>
                      <button
                        onClick={() => { if (confirm(`Remove ${f.username}?`)) removeFriend(f.friendshipId); }}
                        className="text-red-400/60 hover:text-red-400 text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {friendsTab === 'add' && (
                <div>
                  <div className="flex gap-2 mb-3">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSearch()}
                      placeholder="Search by username..."
                      className="ps2-input flex-1 rounded-lg px-3 py-2 text-base sm:text-sm text-blue-100 placeholder-blue-600"
                    />
                    <button
                      onClick={handleSearch}
                      disabled={searchLoading}
                      className="px-4 py-2 ps2-btn text-white rounded-lg text-sm"
                    >
                      {searchLoading ? '...' : 'Search'}
                    </button>
                  </div>

                  <div className="space-y-2">
                    {hasSearched && searchResults.length === 0 ? (
                      <div className="text-center py-6">
                        <div className="text-zinc-400 text-sm">No users found for "{searchQuery}"</div>
                        <div className="text-blue-500 text-xs mt-1">Make sure you're typing their exact username</div>
                      </div>
                    ) : (
                      searchResults.map(u => {
                        const isFriend = friends.some(f => f.id === u.id);
                        return (
                          <div key={u.id} className="flex items-center justify-between p-3 bg-[#0d0d1a] rounded-xl">
                            <span className="text-white text-sm">{u.username}</span>
                            {isFriend ? (
                              <span className="text-emerald-400 text-xs">✓ Friends</span>
                            ) : u.requestSent ? (
                              <span className="text-amber-400 text-xs">✓ Request sent</span>
                            ) : (
                              <button
                                onClick={() => sendRequest(u.id, u.username)}
                                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
                              >
                                Add
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {friendsTab === 'requests' && (
                <div className="space-y-2">
                  {pendingRequests.length === 0 ? (
                    <div className="text-center text-blue-500 py-6 text-sm">No pending requests</div>
                  ) : pendingRequests.map(req => (
                    <div key={req.id} className="flex items-center justify-between p-3 bg-[#0d0d1a] rounded-xl">
                      <div>
                        <span className="text-white text-sm font-medium">{req.requester.username}</span>
                        <div className="text-blue-500 text-[10px]">wants to be your friend</div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => acceptRequest(req.id, req.requester.username)}
                          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg transition-colors"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => declineRequest(req.id)}
                          className="px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-white text-xs rounded-lg transition-colors"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

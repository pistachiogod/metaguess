// fetchGames.js
// Run with: node fetchGames.js

const CLIENT_ID = 'uijc7itihbez5spq8wj3pvxnidsani';
const CLIENT_SECRET = 'mboge7lmypy35kg6xq6thfwrvf3n59';

const GAMES_TO_FETCH = 1500; // Adjust this as needed
const PER_PAGE = 500; // IGDB max per request

async function getAccessToken() {
  const response = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await response.json();
  return data.access_token;
}

async function fetchGamesPage(accessToken, offset = 0) {
  const query = `fields name, first_release_date, genres.name, platforms.name, player_perspectives.name, themes.name, game_modes.name, summary, total_rating, total_rating_count, cover.url, involved_companies.company.name, involved_companies.developer, involved_companies.publisher, franchises.name; sort total_rating_count desc; limit ${PER_PAGE}; offset ${offset};`;
  
  const response = await fetch('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'text/plain',
    },
    body: query
  });
  
  const data = await response.json();
  
  if (offset === 0) {
    console.log(`First game: ${data[0]?.name}`);
  }
  
  return data;
}

async function fetchAllGames(accessToken) {
  const allGames = [];
  const pages = Math.ceil(GAMES_TO_FETCH / PER_PAGE);
  
  for (let i = 0; i < pages; i++) {
    const offset = i * PER_PAGE;
    console.log(`Fetching games ${offset + 1} to ${offset + PER_PAGE}...`);
    
    const games = await fetchGamesPage(accessToken, offset);
    allGames.push(...games);
    
    // Small delay to respect rate limits
    if (i < pages - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  return allGames;
}

function transformGame(game, index) {
  // Extract year from Unix timestamp
  const year = game.first_release_date 
    ? new Date(game.first_release_date * 1000).getFullYear() 
    : null;

  // Get genres
  const genres = game.genres?.map(g => g.name) || [];
  
  // Simplify platforms to categories
  const platformNames = game.platforms?.map(p => p.name) || [];
  const platform = categorizePlatform(platformNames);
  
  // Get perspective
  const perspectives = game.player_perspectives?.map(p => p.name) || [];
  const perspective = perspectives[0] || 'Unknown';
  
  // Get themes
  const themes = game.themes?.map(t => t.name) || [];
  
  // Get game modes
  const gameModes = game.game_modes?.map(m => m.name) || [];
  const isMultiplayer = gameModes.some(m => 
    ['Multiplayer', 'Co-operative', 'Massively Multiplayer Online (MMO)', 'Battle Royale'].includes(m)
  );

  // Get publisher
  const publisher = game.involved_companies?.find(c => c.publisher)?.company?.name || 'Unknown';
  
  // Get franchise
  const franchise = game.franchises?.[0]?.name || null;

  // Cover image URL (make it bigger)
  const coverUrl = game.cover?.url?.replace('t_thumb', 't_cover_big') || null;

  return {
    id: game.id,
    name: game.name,
    year,
    genres,
    primaryGenre: genres[0] || 'Unknown',
    platform,
    allPlatforms: platformNames,
    perspective,
    themes,
    primaryTheme: themes[0] || 'Unknown',
    gameModes,
    isMultiplayer,
    publisher,
    franchise,
    rating: game.total_rating ? Math.round(game.total_rating) : null,
    popularity: game.total_rating_count || 0,
    popularityRank: index + 1,
    description: game.summary || '',
    coverUrl,
    
    // Manual fields - you'll fill these in
    protagonistGender: null,    // Male, Female, Player Choice, Multiple, Non-human, None
    protagonistType: null,      // Human, Custom character, Animal, Robot, Multiple, None
    artStyle: null,             // Realistic, Pixel art, Cel-shaded, Anime, Stylized, Low-poly
    setting: null,           // Medieval, Modern, Future, Post-apocalyptic, Historical, Fantasy
  };
}

function categorizePlatform(platforms) {
  const p = platforms.join(' ').toLowerCase();
  
  const isPC = p.includes('pc') || p.includes('windows') || p.includes('mac') || p.includes('linux');
  const isPlayStation = p.includes('playstation') || p.includes('ps3') || p.includes('ps4') || p.includes('ps5');
  const isXbox = p.includes('xbox');
  const isNintendo = p.includes('nintendo') || p.includes('switch') || p.includes('wii') || p.includes('3ds');
  
  const count = [isPC, isPlayStation, isXbox, isNintendo].filter(Boolean).length;
  
  if (count >= 3) return 'Multi-platform';
  if (count === 0) return 'Other';
  
  // Return primary platform if exclusive-ish
  if (isNintendo && !isPlayStation && !isXbox) return 'Nintendo';
  if (isPlayStation && !isXbox && !isNintendo) return 'PlayStation';
  if (isXbox && !isPlayStation && !isNintendo) return 'Xbox';
  if (isPC && count === 1) return 'PC';
  
  return 'Multi-platform';
}

async function main() {
  console.log('🎮 IGDB Game Fetcher\n');
  console.log('Getting access token...');
  const token = await getAccessToken();
  console.log('✅ Token acquired!\n');
  
  console.log(`Fetching top ${GAMES_TO_FETCH} most popular games from IGDB...\n`);
  const rawGames = await fetchAllGames(token);
  console.log(`\nFetched ${rawGames.length} games total\n`);
  
  // Transform and filter (loose filter for now)
  const games = rawGames
    .map((g, i) => transformGame(g, i))
    .filter(g => g.name);
  
  console.log(`✅ Processed ${games.length} games after filtering\n`);
  
  // Show some stats
  console.log('--- TOP 20 MOST POPULAR GAMES ---');
  games.slice(0, 20).forEach((g, i) => {
    console.log(`${i + 1}. ${g.name} (${g.year}) - ${g.popularity} ratings`);
  });
  
  console.log('\n--- SAMPLE GAME DATA ---');
  console.log(JSON.stringify(games[0], null, 2));
  
  // Save to file
  const fs = await import('fs');
  
  // Full database
  fs.writeFileSync('games-database.json', JSON.stringify(games, null, 2));
  console.log('\n✅ Saved games-database.json');
  
  // CSV for manual editing (just the fields you need to fill in)
  const csvHeader = 'id,name,year,popularityRank,protagonistGender,protagonistType,artStyle,setting';
  const csvRows = games.map(g => 
    `${g.id},"${g.name.replace(/"/g, '""')}",${g.year},${g.popularityRank},,,,`
  );
  fs.writeFileSync('games-manual-fields.csv', [csvHeader, ...csvRows].join('\n'));
  console.log('✅ Saved games-manual-fields.csv');
  
  // Also save a simpler version for quick review
  const reviewList = games.map((g, i) => 
    `${i + 1}. ${g.name} (${g.year}) - ${g.primaryGenre} - ${g.platform}`
  ).join('\n');
  fs.writeFileSync('games-list.txt', reviewList);
  console.log('✅ Saved games-list.txt (quick reference)');
  
  console.log(`\n🎉 Done! You now have ${games.length} games.`);
  console.log('\nNext steps:');
  console.log('1. Open games-manual-fields.csv in Excel/Google Sheets');
  console.log('2. Fill in the empty columns for games you want to include');
  console.log('3. Focus on the top 100-200 first (most likely to be guessed)');
}

main().catch(console.error);

// mergeData.js
// Run with: node mergeData.js
// 
// This script:
// 1. Fetches game data from IGDB API
// 2. Reads your manual fields from CSV
// 3. Merges them into games-database.json

import fs from 'fs';
import path from 'path';

const CLIENT_ID = 'uijc7itihbez5spq8wj3pvxnidsani';
const CLIENT_SECRET = 'mboge7lmypy35kg6xq6thfwrvf3n59';

// Parse CSV file
function parseCSV(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields properly
    const row = lines[i].match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || [];
    const id = parseInt(row[0]);
    
    if (id) {
      data[id] = {
        protagonistGender: row[4]?.replace(/"/g, '').trim() || null,
        protagonistType: row[5]?.replace(/"/g, '').trim() || null,
        artStyle: row[6]?.replace(/"/g, '').trim() || null,
        setting: row[7]?.replace(/"/g, '').trim() || null,
      };
    }
  }
  return data;
}

async function getAccessToken() {
  const response = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await response.json();
  return data.access_token;
}

async function fetchGamesByIds(accessToken, ids) {
  const idList = ids.join(',');
  const query = `
    fields name, first_release_date, genres.name, platforms.name, 
           player_perspectives.name, themes.name, game_modes.name, 
           total_rating, cover.url, involved_companies.company.name, 
           involved_companies.developer;
    where id = (${idList});
    limit 500;
  `;
  
  const response = await fetch('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'text/plain',
    },
    body: query
  });
  
  return response.json();
}

function categorizePlatform(platforms) {
  const p = (platforms || []).join(' ').toLowerCase();
  
  const isPC = p.includes('pc') || p.includes('windows') || p.includes('mac') || p.includes('linux');
  const isPlayStation = p.includes('playstation') || p.includes('ps3') || p.includes('ps4') || p.includes('ps5');
  const isXbox = p.includes('xbox');
  const isNintendo = p.includes('nintendo') || p.includes('switch') || p.includes('wii') || p.includes('3ds');
  
  const count = [isPC, isPlayStation, isXbox, isNintendo].filter(Boolean).length;
  
  if (count >= 3) return 'Multi-platform';
  if (count === 0) return 'Other';
  
  if (isNintendo && !isPlayStation && !isXbox) return 'Nintendo';
  if (isPlayStation && !isXbox && !isNintendo) return 'PlayStation';
  if (isXbox && !isPlayStation && !isNintendo) return 'Xbox';
  if (isPC && count === 1) return 'PC';
  
  return 'Multi-platform';
}

function transformGame(game, manualData, rank) {
  const year = game.first_release_date 
    ? new Date(game.first_release_date * 1000).getFullYear() 
    : null;

  const genres = game.genres?.map(g => g.name) || [];
  const platformNames = game.platforms?.map(p => p.name) || [];
  const platform = categorizePlatform(platformNames);
  const perspectives = game.player_perspectives?.map(p => p.name) || [];
  const themes = game.themes?.map(t => t.name) || [];
  const gameModes = game.game_modes?.map(m => m.name) || [];
  const isMultiplayer = gameModes.some(m => 
    ['Multiplayer', 'Co-operative', 'Massively Multiplayer Online (MMO)', 'Battle Royale'].includes(m)
  );
  const developer = game.involved_companies?.find(c => c.developer)?.company?.name || 'Unknown';
  const coverUrl = game.cover?.url?.replace('t_thumb', 't_cover_big') || null;

  // Merge with manual data
  const manual = manualData[game.id] || {};

  return {
    id: game.id,
    name: game.name,
    year,
    genres,
    primaryGenre: genres[0] || 'Unknown',
    platform,
    perspective: perspectives[0] || 'Unknown',
    themes,
    primaryTheme: themes[0] || 'Unknown',
    isMultiplayer,
    developer,
    rating: game.total_rating ? Math.round(game.total_rating) : null,
    popularityRank: rank,
    coverUrl,
    // Manual fields from CSV
    protagonistGender: manual.protagonistGender || null,
    protagonistType: manual.protagonistType || null,
    artStyle: manual.artStyle || null,
    setting: manual.setting || null,
  };
}

async function main() {
  console.log('🎮 Gamedle Data Merger\n');
  
  // Step 1: Read CSV
  const csvPath = process.argv[2] || '../games-filled-fields-v2.csv';
  console.log(`📄 Reading CSV from: ${csvPath}`);
  
  if (!fs.existsSync(csvPath)) {
    console.error(`❌ CSV file not found at ${csvPath}`);
    console.log('Usage: node mergeData.js <path-to-csv>');
    process.exit(1);
  }
  
  const manualData = parseCSV(csvPath);
  const gameIds = Object.keys(manualData).map(Number);
  console.log(`✅ Found ${gameIds.length} games in CSV\n`);
  
  // Step 2: Fetch from IGDB
  console.log('🔑 Getting IGDB access token...');
  const token = await getAccessToken();
  console.log('✅ Token acquired!\n');
  
  console.log('📥 Fetching game data from IGDB...');
  
  // Fetch in batches of 100 (IGDB limit for "where id in")
  const allGames = [];
  for (let i = 0; i < gameIds.length; i += 100) {
    const batch = gameIds.slice(i, i + 100);
    console.log(`  Fetching batch ${Math.floor(i/100) + 1}/${Math.ceil(gameIds.length/100)}...`);
    const games = await fetchGamesByIds(token, batch);
    allGames.push(...games);
    
    if (i + 100 < gameIds.length) {
      await new Promise(r => setTimeout(r, 300)); // Rate limit
    }
  }
  console.log(`✅ Fetched ${allGames.length} games from IGDB\n`);
  
  // Step 3: Transform and merge
  console.log('🔄 Merging data...');
  
  // Create a map for quick lookup and preserve CSV order
  const igdbMap = {};
  allGames.forEach(g => { igdbMap[g.id] = g; });
  
  const mergedGames = [];
  let rank = 1;
  
  for (const id of gameIds) {
    if (igdbMap[id]) {
      mergedGames.push(transformGame(igdbMap[id], manualData, rank));
      rank++;
    } else {
      console.log(`  ⚠️ Game ID ${id} not found in IGDB`);
    }
  }
  
  console.log(`✅ Merged ${mergedGames.length} games\n`);
  
  // Step 4: Save
  const outputPath = './src/games-database.json';
  fs.writeFileSync(outputPath, JSON.stringify(mergedGames, null, 2));
  console.log(`💾 Saved to ${outputPath}\n`);
  
  // Show sample
  console.log('--- SAMPLE OUTPUT ---');
  console.log(JSON.stringify(mergedGames[0], null, 2));
  
  console.log(`\n🎉 Done! ${mergedGames.length} games ready for Gamedle.`);
}

main().catch(console.error);

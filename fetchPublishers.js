// fetchPublishers.js
// Updates your existing games-database.json with publisher names from IGDB
// Run with: node fetchPublishers.js

import fs from 'fs';

const CLIENT_ID = 'uijc7itihbez5spq8wj3pvxnidsani';
const CLIENT_SECRET = 'mboge7lmypy35kg6xq6thfwrvf3n59';

async function getAccessToken() {
  const response = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await response.json();
  return data.access_token;
}

async function fetchPublishersForIds(accessToken, ids) {
  // IGDB allows up to 500 per request, but we'll batch in groups of 50 to be safe
  const results = {};
  const batchSize = 50;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const idList = batch.join(',');

    const query = `fields name, involved_companies.company.name, involved_companies.publisher; where id = (${idList}); limit ${batchSize};`;

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

    for (const game of data) {
      const publisher = game.involved_companies?.find(c => c.publisher)?.company?.name || null;
      results[game.id] = publisher;
    }

    console.log(`Fetched ${i + batch.length} / ${ids.length} games...`);

    // Rate limit delay
    if (i + batchSize < ids.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return results;
}

async function main() {
  // Load existing database
  const games = JSON.parse(fs.readFileSync('src/games-database.json', 'utf-8'));
  console.log(`Loaded ${games.length} games from database\n`);

  // Get all game IDs
  const ids = games.map(g => g.id);

  console.log('Getting access token...');
  const token = await getAccessToken();
  console.log('✅ Token acquired!\n');

  console.log('Fetching publisher data from IGDB...\n');
  const publishers = await fetchPublishersForIds(token, ids);

  // Update games with publisher data
  let updated = 0;
  let notFound = 0;

  for (const game of games) {
    const publisher = publishers[game.id];
    if (publisher) {
      game.publisher = publisher;
      updated++;
    } else {
      // Keep existing value or set Unknown
      if (!game.publisher) game.publisher = 'Unknown';
      notFound++;
    }
  }

  // Save updated database
  fs.writeFileSync('src/games-database.json', JSON.stringify(games, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   Updated: ${updated} games with publisher names`);
  console.log(`   Not found: ${notFound} games (kept existing or set to Unknown)`);

  // Show some examples
  console.log('\n--- SAMPLE PUBLISHERS ---');
  games.slice(0, 15).forEach(g => {
    console.log(`  ${g.name} → ${g.publisher}`);
  });
}

main().catch(console.error);

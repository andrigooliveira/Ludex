// Capas do SteamGridDB, para jogos que não existem na loja da Steam.
// Precisa de uma chave gratuita da conta do usuário (Preferences > API).
const API = 'https://www.steamgriddb.com/api/v2';

async function call(key, route) {
  const res = await fetch(API + route, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Chave recusada pelo SteamGridDB.'), { auth: true });
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).data || [];
}

async function searchGames(key, term) {
  const games = await call(key, `/search/autocomplete/${encodeURIComponent(term)}`);
  return games.map((game) => ({ ref: String(game.id), name: game.name }));
}

// Capas verticais (formato de biblioteca), as mais votadas primeiro.
async function gridUrls(key, gameId) {
  const grids = await call(
    key,
    `/grids/game/${encodeURIComponent(gameId)}?dimensions=600x900,342x482,660x930&types=static&nsfw=false&humor=false`
  );
  return grids.slice(0, 3).map((grid) => grid.url);
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Tenta cada termo em ordem; prefere o jogo com nome idêntico.
async function findCovers(key, terms) {
  for (const term of terms) {
    const games = await searchGames(key, term);
    if (!games.length) continue;
    const game = games.find((g) => normalize(g.name) === normalize(term)) || games[0];
    return { gameId: game.ref, name: game.name, covers: await gridUrls(key, game.ref) };
  }
  return null;
}

module.exports = { searchGames, gridUrls, findCovers };

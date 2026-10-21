// Biblioteca completa da conta Steam (jogos instalados ou não), pela Web API
// oficial. Precisa da chave pessoal do usuário: steamcommunity.com/dev/apikey
const { summarize } = require('./scanners/steamAchievements');

const API = 'https://api.steampowered.com';

// A pasta em userdata usa o ID curto da conta; a API pede o SteamID de 64 bits.
const toSteamId64 = (accountId) => (76561197960265728n + BigInt(accountId)).toString();

async function fetchOwnedGames(key, steamId) {
  const url = `${API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${steamId}`
    + '&include_appinfo=1&include_played_free_games=1&format=json';
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Chave recusada pela Steam.'), { auth: true });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const games = ((await res.json()).response || {}).games || [];
  return games.filter((g) => g.name).map((g) => ({
    appid: String(g.appid),
    name: g.name,
    minutes: g.playtime_forever || 0,
    recent: g.playtime_2weeks || 0, // minutos nas duas últimas semanas, contados pela Steam
    lastPlayed: g.rtime_last_played || 0,
    icon: g.img_icon_url || null,
  }));
}

// Conquistas pela Web API, para jogos sem cache local (não instalados, por exemplo).
// Devolve o mesmo formato de readAchievements, ou null se o jogo não tem conquistas.
async function fetchAchievements(key, steamId, appid) {
  const stats = `${API}/ISteamUserStats`;
  const auth = `key=${encodeURIComponent(key)}&appid=${appid}`;
  const schema = await fetch(`${stats}/GetSchemaForGame/v2/?${auth}&l=brazilian`, { signal: AbortSignal.timeout(15000) });
  if (!schema.ok) throw new Error(`HTTP ${schema.status}`);
  const definitions = (((await schema.json()).game || {}).availableGameStats || {}).achievements || [];
  if (!definitions.length) return null;

  // Sem estatísticas para esta conta a Steam responde com erro: fica tudo bloqueado.
  const unlocked = new Map();
  const player = await fetch(`${stats}/GetPlayerAchievements/v1/?${auth}&steamid=${steamId}`, { signal: AbortSignal.timeout(15000) });
  if (player.ok) {
    for (const item of ((await player.json()).playerstats || {}).achievements || []) {
      if (item.achieved) unlocked.set(item.apiname, item.unlocktime || 0);
    }
  }

  return summarize(definitions.map((def) => {
    const done = unlocked.has(def.name);
    const hidden = Number(def.hidden) === 1;
    return {
      name: def.displayName || def.name,
      description: hidden && !done ? '' : def.description || '',
      hidden,
      unlocked: done,
      unlockedAt: unlocked.get(def.name) || 0,
      icon: (done ? def.icon : def.icongray || def.icon) || null,
    };
  }));
}

module.exports = { fetchOwnedGames, fetchAchievements, toSteamId64 };

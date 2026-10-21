// Conquistas dos jogos da Steam, lidas do cache local do cliente
// (appcache/stats): não precisa de chave de API nem de perfil público.
const fs = require('fs');
const path = require('path');

// VDF binário da Valve: cada entrada é [tipo][chave\0][valor]; 0x08 fecha o bloco.
function parseBinaryVdf(buf) {
  let pos = 0;
  const readString = () => {
    const end = buf.indexOf(0, pos);
    const text = buf.toString('utf8', pos, end);
    pos = end + 1;
    return text;
  };
  const readMap = () => {
    const map = {};
    while (pos < buf.length) {
      const type = buf[pos++];
      if (type === 0x08 || type === 0x0b) break;
      const key = readString();
      if (type === 0x00) map[key] = readMap();
      else if (type === 0x01) map[key] = readString();
      else if (type === 0x02) { map[key] = buf.readInt32LE(pos); pos += 4; }
      else if (type === 0x03) { map[key] = buf.readFloatLE(pos); pos += 4; }
      else if (type === 0x07 || type === 0x0a) { map[key] = Number(buf.readBigUInt64LE(pos)); pos += 8; }
      else throw new Error(`Tipo VDF desconhecido: ${type}`);
    }
    return map;
  };
  return readMap();
}

// Textos vêm como string ou como mapa por idioma.
function pickText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.brazilian || value.english || Object.values(value).find((v) => typeof v === 'string') || '';
}

// Bits desbloqueados por stat, juntando todas as contas que já jogaram neste PC.
function readProgress(dir, appid) {
  const progress = {};
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => new RegExp(`^UserGameStats_\\d+_${appid}\\.bin$`).test(f));
  } catch {
    // Sem pasta de stats.
  }
  for (const file of files) {
    try {
      const cache = parseBinaryVdf(fs.readFileSync(path.join(dir, file))).cache || {};
      for (const [statId, stat] of Object.entries(cache)) {
        if (!stat || typeof stat !== 'object') continue;
        const times = stat.AchievementTimes || {};
        const mask = (stat.data || 0) >>> 0;
        for (let bit = 0; bit < 32; bit++) {
          if (!((mask >>> bit) & 1) && !times[bit]) continue;
          progress[statId] ??= {};
          progress[statId][bit] = Math.max(progress[statId][bit] || 0, times[bit] || 0);
        }
      }
    } catch {
      // Arquivo de progresso ilegível: ignora.
    }
  }
  return progress;
}

function readAchievements(steamPath, appid) {
  const dir = path.join(steamPath, 'appcache', 'stats');
  let stats;
  try {
    stats = parseBinaryVdf(fs.readFileSync(path.join(dir, `UserGameStatsSchema_${appid}.bin`)))[appid].stats;
  } catch {
    return null; // jogo sem conquistas ou nunca aberto nesta Steam
  }

  const progress = readProgress(dir, appid);
  const icons = `https://cdn.steamstatic.com/steamcommunity/public/images/apps/${appid}`;
  const items = [];
  for (const [statId, stat] of Object.entries(stats || {})) {
    for (const [key, info] of Object.entries((stat && stat.bits) || {})) {
      const display = info.display || {};
      const bit = info.bit ?? Number(key);
      const unlockedAt = progress[statId] && progress[statId][bit];
      const unlocked = unlockedAt !== undefined;
      const hidden = String(display.hidden) === '1';
      const icon = unlocked ? display.icon : display.icon_gray || display.icon;
      items.push({
        name: pickText(display.name) || info.name,
        // A Steam não revela a descrição das secretas antes de desbloquear.
        description: hidden && !unlocked ? '' : pickText(display.desc),
        hidden,
        unlocked,
        unlockedAt: unlockedAt || 0,
        icon: icon ? `${icons}/${icon}` : null,
      });
    }
  }
  return summarize(items);
}

// Formato final da lista: desbloqueadas primeiro, da mais recente para a mais antiga.
function summarize(items) {
  if (!items.length) return null;
  items.sort((a, b) => b.unlocked - a.unlocked || b.unlockedAt - a.unlockedAt);
  return { total: items.length, unlocked: items.filter((i) => i.unlocked).length, items };
}

module.exports = { readAchievements, summarize };

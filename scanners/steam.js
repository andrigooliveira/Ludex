const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { readAchievements } = require('./steamAchievements');

// Entradas da Steam que não são jogos (runtimes, redistribuíveis, Proton...).
const IGNORED_IDS = new Set(['228980']);
const IGNORED_NAMES = /^(Steamworks Common|Steam Linux Runtime|Proton )/i;

// Parser mínimo do formato VDF/ACF da Valve ("chave" "valor" e blocos { }).
function parseVdf(text) {
  const root = {};
  const stack = [];
  let current = root;
  let key = null;
  const re = /"((?:\\.|[^"\\])*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[2] === '{') {
      const child = {};
      current[key] = child;
      stack.push(current);
      current = child;
      key = null;
    } else if (m[2] === '}') {
      current = stack.pop() || root;
    } else {
      const value = m[1].replace(/\\(.)/g, '$1');
      if (key === null) {
        key = value;
      } else {
        current[key] = value;
        key = null;
      }
    }
  }
  return root;
}

// A Steam varia a caixa das chaves entre versões ("Software"/"software").
function dig(obj, keys) {
  for (const key of keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
    obj = found === undefined ? undefined : obj[found];
  }
  return obj;
}

function readRegistry(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/REG_SZ\s+(.+)/);
      resolve(m ? m[1].trim() : null);
    });
  });
}

let steamPathPromise;
function findSteamPath() {
  steamPathPromise ??= (async () => {
    const candidates = [
      await readRegistry('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      await readRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
      'C:\\Program Files (x86)\\Steam',
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(path.join(c, 'steamapps'))) return path.normalize(c);
    }
    return null;
  })();
  return steamPathPromise;
}

function libraryFolders(steamPath) {
  const folders = new Set([steamPath]);
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    for (const entry of Object.values(vdf.libraryfolders || {})) {
      if (entry && entry.path) folders.add(path.normalize(entry.path));
    }
  } catch {
    // Sem libraryfolders.vdf: fica só a pasta principal.
  }
  return [...folders];
}

const CDN = 'https://shared.steamstatic.com/store_item_assets/steam/apps';
const cacheDir = (steamPath, appid) => path.join(steamPath, 'appcache', 'librarycache', appid);

// Artes que a Steam já baixou para este app. Ela as guarda direto na pasta
// do app ou em subpastas com hash. steamPath pode ser null (sem Steam instalada).
function localArt(steamPath, appid, names) {
  if (!steamPath) return [];
  const appDir = cacheDir(steamPath, appid);
  const dirs = [appDir];
  try {
    for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(appDir, entry.name));
    }
  } catch {
    // Jogo sem cache local: cai direto na CDN.
  }
  return names
    .flatMap((name) => dirs.map((dir) => path.join(dir, name)))
    .filter((file) => fs.existsSync(file))
    .map((file) => pathToFileURL(file).href);
}

// Capas verticais em ordem de preferência: cache local primeiro, CDN depois.
function coverCandidates(steamPath, appid) {
  return [
    ...localArt(steamPath, appid, ['library_600x900.jpg', 'library_capsule.jpg']),
    `${CDN}/${appid}/library_600x900.jpg`,
    `${CDN}/${appid}/header.jpg`,
  ];
}

// Banner largo da página do jogo.
function heroCandidates(steamPath, appid) {
  return [
    ...localArt(steamPath, appid, ['library_hero.jpg']),
    `${CDN}/${appid}/library_hero.jpg`,
    `${CDN}/${appid}/header.jpg`,
  ];
}

// Ícone pequeno do jogo: o arquivo solto com nome em hash na pasta do app.
function localIcon(steamPath, appid) {
  if (!steamPath) return null;
  try {
    const dir = cacheDir(steamPath, appid);
    const file = fs.readdirSync(dir).find((name) => /^[0-9a-f]{40}\.jpg$/.test(name));
    return file ? pathToFileURL(path.join(dir, file)).href : null;
  } catch {
    return null;
  }
}

// Minutos jogados e última sessão por appid, lidos do perfil local da Steam.
function readPlaytimes(steamPath) {
  const result = new Map();
  let users;
  try {
    users = fs.readdirSync(path.join(steamPath, 'userdata'));
  } catch {
    return result;
  }
  for (const user of users) {
    try {
      const file = path.join(steamPath, 'userdata', user, 'config', 'localconfig.vdf');
      const apps = dig(parseVdf(fs.readFileSync(file, 'utf8')), ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps']);
      for (const [appid, app] of Object.entries(apps || {})) {
        const previous = result.get(appid) || { minutes: 0, lastPlayed: 0 };
        result.set(appid, {
          minutes: Math.max(previous.minutes, Number(app.Playtime) || 0),
          lastPlayed: Math.max(previous.lastPlayed, Number(app.LastPlayed) || 0),
        });
      }
    } catch {
      // Perfil sem localconfig legível: ignora.
    }
  }
  return result;
}

// Conta que usou esta Steam por último (pasta em userdata com o perfil mais recente).
function findSteamAccount(steamPath) {
  let best = null;
  try {
    for (const user of fs.readdirSync(path.join(steamPath, 'userdata'))) {
      if (!/^[1-9]\d*$/.test(user)) continue;
      try {
        const mtime = fs.statSync(path.join(steamPath, 'userdata', user, 'config', 'localconfig.vdf')).mtimeMs;
        if (!best || mtime > best.mtime) best = { user, mtime };
      } catch {
        // Pasta sem perfil.
      }
    }
  } catch {
    // Sem userdata.
  }
  return best && best.user;
}

// Coleções da biblioteca da Steam (cópia local da nuvem): as criadas pelo
// usuário e a lista de ocultos. As dinâmicas ficam de fora, porque são
// filtros e não listas de jogos.
function readSteamCollections(steamPath) {
  const result = { collections: [], hidden: [] };
  const account = findSteamAccount(steamPath);
  if (!account) return result;
  try {
    const file = path.join(steamPath, 'userdata', account, 'config', 'cloudstorage', 'cloud-storage-namespace-1.json');
    for (const [key, entry] of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (!key.startsWith('user-collections.') || entry.is_deleted || !entry.value) continue;
      const collection = JSON.parse(entry.value);
      const appids = (collection.added || []).map(String);
      if (key === 'user-collections.hidden') result.hidden = appids;
      else if (collection.name && !collection.filterSpec) result.collections.push({ name: collection.name, appids });
    }
  } catch {
    // Sem cópia local das coleções.
  }
  return result;
}

function hasFiles(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

async function scanSteam() {
  const steamPath = await findSteamPath();
  if (!steamPath) return [];

  const playtimes = readPlaytimes(steamPath);
  const games = new Map();
  for (const folder of libraryFolders(steamPath)) {
    const apps = path.join(folder, 'steamapps');
    let files;
    try {
      files = fs.readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const state = parseVdf(fs.readFileSync(path.join(apps, file), 'utf8')).AppState;
        if (!state || !state.appid || !state.name) continue;
        if (IGNORED_IDS.has(state.appid) || IGNORED_NAMES.test(state.name)) continue;
        // A Steam às vezes deixa o manifesto para trás depois de desinstalar;
        // sem a pasta do jogo, ele não está instalado de verdade.
        const folder = path.join(apps, 'common', state.installdir || '');
        if (!hasFiles(folder)) continue;

        const played = playtimes.get(state.appid) || { minutes: 0, lastPlayed: 0 };
        const achievements = readAchievements(steamPath, state.appid);
        games.set(state.appid, {
          id: `steam:${state.appid}`,
          appid: state.appid,
          name: state.name,
          source: 'Steam',
          // StateFlags exatamente 4 = instalado e em dia; qualquer outro bit é update/download pendente.
          ready: Number(state.StateFlags) === 4,
          playtimeMinutes: played.minutes,
          lastPlayed: played.lastPlayed || Number(state.LastPlayed) || 0,
          version: state.buildid ? `build ${state.buildid}` : null,
          updated: Number(state.LastUpdated) || 0,
          achievements: achievements && { unlocked: achievements.unlocked, total: achievements.total },
          folder,
          launch: { type: 'url', target: `steam://rungameid/${state.appid}` },
          // A Steam abre a própria janela de confirmação.
          uninstall: { type: 'url', target: `steam://uninstall/${state.appid}` },
          size: Number(state.SizeOnDisk) || null, // a Steam já anota o tamanho no manifesto
        });
      } catch {
        // Manifesto ilegível: ignora só esse jogo.
      }
    }
  }
  return [...games.values()];
}

module.exports = { scanSteam, findSteamPath, findSteamAccount, readSteamCollections, coverCandidates, heroCandidates, localIcon, parseVdf };

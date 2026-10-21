const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, nativeImage, Tray, Menu, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const { scanSteam, findSteamPath, findSteamAccount, readSteamCollections, coverCandidates, heroCandidates, localIcon } = require('./scanners/steam');
const { scanEpic } = require('./scanners/epic');
const { readAchievements } = require('./scanners/steamAchievements');
const { searchStore, autoMatch, fetchDetails } = require('./metadata');
const { scanGog, scanUbisoft, scanEa, registeredUninstallers } = require('./scanners/stores');
const sgdb = require('./sgdb');
const { fetchOwnedGames, fetchAchievements, toSteamId64 } = require('./steamAccount');
const storeAccounts = require('./accounts');
const { dominantColor } = require('./accent');
const { Downloads } = require('./downloads');
const realDebrid = require('./realdebrid');
const { Sources } = require('./sources');
const { Saves } = require('./saves');

// O app se chamava "Game Launcher" e guardava tudo em %APPDATA%\\Game Launcher. Na
// primeira abertura como Ludex, copia de lá os dados (biblioteca, contas, fila de
// downloads, fontes, a chave que cifra os tokens), sem os caches do navegador.
// A pasta antiga fica como está, de reserva.
(function bringOldData() {
  const current = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'Game Launcher');
  if (path.resolve(current) === path.resolve(old) || fs.existsSync(path.join(current, 'settings.json')) || !fs.existsSync(old)) return;
  const skip = /^[\\/](Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|blob_storage|Shared Dictionary|Crashpad)([\\/]|$)|[\\/]lockfile$/i;
  try {
    fs.cpSync(old, current, { recursive: true, force: false, errorOnExist: false, filter: (source) => !skip.test(source.slice(old.length)) });
  } catch {
    // Não deu para copiar: o Ludex começa vazio e a pasta antiga continua lá.
  }
})();

const manualFile = () => path.join(app.getPath('userData'), 'manual-games.json');
const libraryFile = () => path.join(app.getPath('userData'), 'library.json');
const appIcon = path.join(__dirname, 'assets', 'icon.ico'); // gerado por scripts/build-app-icon.js
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const achievementsFile = () => path.join(app.getPath('userData'), 'achievements.json');

// Uma janela só: duas cópias abertas gravariam library.json uma por cima da outra.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => showWindow());

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const readManual = () => readJson(manualFile(), []);
const writeManual = (list) => writeJson(manualFile(), list);

// library.json guarda o que foi descoberto sobre os jogos:
//   meta:    informações da loja, por appid da Steam
//   matches: appid da Steam escolhido para cada jogo de fora da Steam (null = nenhum)
//   covers:  capa escolhida à mão, por id do jogo
//   sgdb:    capas do SteamGridDB para jogos sem correspondência na Steam (null = nada achado)
//   owned:   jogos da conta Steam (instalados ou não), da última consulta à Web API
//   categories: categorias criadas pelo usuário, cada uma com os ids dos seus jogos
//   hidden:  ids dos jogos ocultos
//   accounts: jogos das contas GOG e Epic, da última consulta a cada loja
//   colors:  cor de destaque calculada para cada capa, por URL (null = capa sem cor)
//   play:    tempo de jogo contado pelo launcher para jogos de fora da Steam
//   recent:  sessões de jogo abertas pelo launcher no último ano ({ id, at, seconds }; at = fim, em segundos)
//   exes:    executável escolhido à mão para jogos de loja abertos pelo executável (GOG, EA), por id
//   sizes:   tamanho medido da pasta de cada jogo instalado ({ bytes, at }), por id
//   saveDirs: pastas de save escolhidas à mão (jogos fora do catálogo), por id
//   backups:  quando foi o último backup de saves de cada jogo ({ at }), por id
let library;
function getLibrary() {
  library ??= { meta: {}, matches: {}, covers: {}, sgdb: {}, owned: null, categories: [], hidden: [], play: {}, recent: [], exes: {}, sizes: {}, saveDirs: {}, backups: {}, accounts: {}, colors: {}, ...readJson(libraryFile(), {}) };
  return library;
}
// Falha ao gravar não derruba quem chamou (a lista em memória continua valendo),
// mas fica registrada em erros.log na pasta de dados, para dar para investigar.
function saveLibrary() {
  try {
    writeJson(libraryFile(), getLibrary());
  } catch (err) {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'erros.log'), `${new Date().toISOString()} library.json: ${err.stack || err}
`);
    } catch {
      // Sem conseguir nem registrar, segue só com a memória.
    }
  }
}

// As chaves (SteamGridDB, Web API da Steam) ficam cifradas pelo Windows (DPAPI),
// presas a este usuário.
function getSecret(name) {
  const stored = readJson(settingsFile(), {})[name];
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

function setSecret(name, value) {
  const settings = readJson(settingsFile(), {});
  if (value) settings[name] = safeStorage.encryptString(value).toString('base64');
  else delete settings[name];
  writeJson(settingsFile(), settings);
}

const getSgdbKey = () => getSecret('sgdbKey');
const setSgdbKey = (key) => setSecret('sgdbKey', key);

async function steamId() {
  const steamPath = await findSteamPath();
  const account = steamPath && findSteamAccount(steamPath);
  return account ? toSteamId64(account) : null;
}

// Atualiza a lista de jogos da conta, no máximo uma vez por hora (ou quando forçado).
const OWNED_MAX_AGE = 60 * 60 * 1000;
async function refreshOwned(force) {
  const key = getSecret('steamKey');
  const id = key && await steamId();
  if (!id) return false;
  const lib = getLibrary();
  const fresh = lib.owned && lib.owned.steamId === id && Date.now() - lib.owned.fetchedAt < OWNED_MAX_AGE;
  if (fresh && !force) return false;
  try {
    lib.owned = { steamId: id, fetchedAt: Date.now(), games: await fetchOwnedGames(key, id) };
    saveLibrary();
    return true;
  } catch {
    return false; // sem internet: fica com a lista guardada
  }
}

// Jogos da última varredura, por id. O renderer só manda o id; o que
// realmente é executado sai daqui, nunca de dados vindos da página.
let games = new Map();

const versionCache = new Map();
function readExeVersion(exe, mtime) {
  const key = `${exe}|${mtime}`;
  if (!versionCache.has(key)) {
    versionCache.set(key, new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:GL_EXE).VersionInfo.ProductVersion'],
        { env: { ...process.env, GL_EXE: exe }, windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          const version = String(stdout || '').trim();
          // Muitos jogos deixam lixo nesse campo (ex.: "UE5-CL-0", "0.0.0.0").
          const valid = !err && /^\d+(\.\d+)+/.test(version) && !/^0(\.0)*$/.test(version);
          resolve(valid ? version : null);
        }
      );
    }));
  }
  return versionCache.get(key);
}

async function scanManual() {
  return Promise.all(readManual().filter((entry) => fs.existsSync(entry.exe)).map(async (entry) => {
    let icon = null;
    try {
      icon = (await app.getFileIcon(entry.exe, { size: 'large' })).toDataURL();
    } catch {
      // Sem ícone: o card mostra só o nome.
    }
    const mtime = fs.statSync(entry.exe).mtimeMs;
    return {
      id: entry.id,
      name: entry.name,
      source: 'Manual',
      icon,
      ready: true,
      playtimeMinutes: Math.round((entry.playSeconds || 0) / 60),
      lastPlayed: entry.lastPlayed || 0,
      version: await readExeVersion(entry.exe, mtime),
      updated: Math.round(mtime / 1000),
      exe: entry.exe,
      folder: path.dirname(entry.exe),
      launch: { type: 'exe', target: entry.exe },
    };
  }));
}

// Junta ao jogo a capa e as informações da loja que já estão guardadas.
function decorate(game, steamPath) {
  const lib = getLibrary();
  const appid = game.appid || lib.matches[game.id] || null;
  const meta = (appid && lib.meta[appid]) || {};
  // Ordem das capas: a escolhida à mão, a vertical da loja, as da Steam, as do
  // SteamGridDB e, por último, a horizontal da loja (fica cortada no formato vertical).
  const covers = [...(game.coverFirst ? [game.coverFirst] : []), ...(appid ? coverCandidates(steamPath, appid) : [])];
  const custom = lib.covers[game.id];
  if (custom && fs.existsSync(custom)) covers.unshift(pathToFileURL(custom).href);
  const fromSgdb = lib.sgdb[game.id];
  if (fromSgdb && fromSgdb.covers) covers.push(...fromSgdb.covers);
  if (game.coverLast) covers.push(game.coverLast);
  return {
    ...game,
    appid,
    installed: game.installed !== false,
    hidden: lib.hidden.includes(game.id),
    playtimeMinutes: game.playtimeMinutes ?? Math.round(((lib.play[game.id] || {}).seconds || 0) / 60),
    lastPlayed: game.lastPlayed ?? (lib.play[game.id] || {}).lastPlayed ?? 0,
    // Aberto pelo launcher e ainda rodando: desde quando (ms), ou null.
    runningSince: (sessions.get(game.id) || {}).startedAt || null,
    // Bytes no disco: o que a loja informa ou o que o launcher mediu.
    lastBackup: (lib.backups[game.id] || {}).at || null,
    sizeBytes: game.installed === false ? null : game.size || (lib.sizes[game.id] || {}).bytes || null,
    recentMinutes: recentMinutes(game),
    version: game.version ?? null,
    updated: game.updated ?? 0,
    // Conquistas: do cache local da Steam ou, sem ele, da última consulta à Web API.
    achievements: game.achievements || (game.source === 'Steam' ? achievementSummary(appid) : null),
    categories: lib.categories.filter((c) => c.games.includes(game.id)).map((c) => c.id),
    covers,
    heroes: appid ? heroCandidates(steamPath, appid) : [],
    // Cor de destaque: a da primeira capa que já foi analisada.
    accent: lib.colors[covers.find((url) => url in lib.colors)] || null,
    // Miniatura para a lista: ícone da Steam ou, nos manuais, o do executável.
    thumb: (appid && localIcon(steamPath, appid)) || game.iconUrl || game.icon || null,
    genres: meta.genres || [],
    developer: meta.developer || null,
    released: meta.released || null,
    description: meta.description || null,
    metacritic: meta.metacritic || null,
  };
}

async function scanAll() {
  const [steamPath, ...sources] = await Promise.all([
    findSteamPath(),
    ...[scanSteam, scanEpic, scanGog, scanUbisoft, scanEa, scanManual].map((scan) => scan().catch(() => [])),
  ]);
  const found = sources.flat();
  // Com a conta ligada, entram também os jogos da Steam que não estão instalados.
  const owned = getSecret('steamKey') && getLibrary().owned;
  steamRecent = new Map((owned ? owned.games : []).map((game) => [game.appid, game.recent || 0]));
  const known = new Set(found.map((g) => g.id));
  for (const game of owned ? owned.games : []) {
    if (known.has(`steam:${game.appid}`)) continue;
    found.push({
      id: `steam:${game.appid}`,
      appid: game.appid,
      name: game.name,
      source: 'Steam',
      installed: false,
      iconUrl: game.icon ? `https://cdn.steamstatic.com/steamcommunity/public/images/apps/${game.appid}/${game.icon}.jpg` : null,
      ready: true,
      playtimeMinutes: game.minutes,
      lastPlayed: game.lastPlayed,
      version: null,
      updated: 0,
      launch: { type: 'url', target: `steam://install/${game.appid}` },
    });
  }
  // Idem para as contas GOG e Epic conectadas.
  for (const [store, account] of Object.entries(storeAccounts)) {
    const saved = getSecret(`${store}Auth`) && getLibrary().accounts[store];
    for (const game of saved ? saved.games : []) {
      if (known.has(game.id)) continue;
      found.push({
        id: game.id,
        name: game.title,
        source: account.name,
        installed: false,
        ready: true,
        coverFirst: game.tall,
        coverLast: game.wide,
        launch: { type: 'url', target: game.launch },
      });
    }
  }
  // Executável trocado à mão (jogos de loja; nos manuais a troca vale direto no cadastro).
  for (const game of found) {
    const custom = getLibrary().exes[game.id];
    if (custom && game.launch.type === 'exe' && fs.existsSync(custom)) {
      game.exe = custom;
      game.launch = { type: 'exe', target: custom };
    }
  }
  const list = found
    .map((game) => decorate(game, steamPath))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  games = new Map(list.map((g) => [g.id, g]));
  return list.map(({ launch, exe, folder, uninstall, size, ...visible }) => ({
    ...visible,
    hasFolder: Boolean(folder),
    // Só quem é aberto pelo executável (manuais, GOG, EA) pode trocar de executável.
    canChangeExe: visible.installed && launch.type === 'exe',
    exeName: launch.type === 'exe' ? path.basename(launch.target) : null,
    canUninstall: visible.installed && (Boolean(uninstall) || visible.source === 'Manual'),
  }));
}

function notifyChanged() {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('games:changed');
}

// Nomes para procurar na loja a partir do executável: "Bodycam.exe" e a pasta dele.
function searchTerms(game) {
  if (!game.exe) return [game.name];
  const clean = (s) => s
    .replace(/[-_. ]*(win64|win32|x64|x86|shipping|launcher)\b/gi, '')
    .replace(/[_.]+/g, ' ')
    .trim();
  const terms = [game.name, clean(path.parse(game.exe).name), clean(path.basename(path.dirname(game.exe)))];
  return [...new Set(terms.filter(Boolean))];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Próximo appid sem informações da loja; instalados e manuais têm prioridade
// sobre o resto da conta.
function nextMissingMeta() {
  const lib = getLibrary();
  let fallback = null;
  for (const game of games.values()) {
    const appid = game.appid;
    if (!appid || lib.meta[appid] || failed.has(appid)) continue;
    if (game.installed) return appid;
    fallback ??= appid;
  }
  return fallback;
}

// Informações da loja, um appid por vez. A loja aceita por volta de 200
// consultas a cada 5 minutos, então contas grandes são preenchidas aos poucos.
let fetchingMeta = false;
async function enrichMeta() {
  if (fetchingMeta) return;
  fetchingMeta = true;
  const lib = getLibrary();
  let pending = 0;
  let total = 0;
  const flush = () => {
    if (!pending) return;
    pending = 0;
    saveLibrary();
    notifyChanged();
  };
  try {
    for (let appid = nextMissingMeta(); appid; appid = nextMissingMeta()) {
      try {
        lib.meta[appid] = await fetchDetails(appid);
        pending++;
      } catch (err) {
        if (err.rateLimited) {
          setTimeout(enrichMeta, 5 * 60 * 1000);
          break;
        }
        failed.add(appid);
      }
      if (++total <= 5 || pending >= 10) flush();
      if (total > 20) await sleep(1600);
    }
  } finally {
    fetchingMeta = false;
    flush();
  }
}

// Busca em segundo plano a qual jogo da loja cada jogo de fora da Steam
// corresponde (e a capa do SteamGridDB para quem ficou sem).
const failed = new Set();
let enriching = false;
async function enrich() {
  if (enriching) return;
  enriching = true;
  const lib = getLibrary();
  let changed = false;
  try {
    for (const game of games.values()) {
      if (game.source === 'Steam' || game.id in lib.matches || failed.has(game.id)) continue;
      try {
        lib.matches[game.id] = await autoMatch(searchTerms(game));
        await sleep(200); // contas grandes: não martela a busca da loja
        changed = true;
      } catch {
        failed.add(game.id); // sem internet: tenta de novo na próxima abertura
      }
    }
    const key = getSgdbKey();
    for (const game of key ? games.values() : []) {
      // Só para quem ficou sem correspondência na Steam.
      if (game.source === 'Steam' || lib.matches[game.id] !== null) continue;
      if (game.id in lib.sgdb || failed.has(`sgdb:${game.id}`)) continue;
      try {
        lib.sgdb[game.id] = await sgdb.findCovers(key, searchTerms(game));
        changed = true;
      } catch {
        failed.add(`sgdb:${game.id}`);
      }
    }
  } finally {
    enriching = false;
  }
  if (changed) {
    saveLibrary();
    notifyChanged(); // a nova varredura dispara enrichMeta para os appids recém-descobertos
  } else {
    enrichMeta();
  }
}

// ---------- Jogando agora ----------
// Jogo aberto pelo launcher: id -> { names, folder, pids, launchedAt, startedAt, lastSeen, checkedAt, verifiedAt }.
// Muitos jogos abrem por um executável que logo sai e deixa outro rodando, então
// em vez de seguir o processo iniciado o launcher acompanha os processos cujo
// executável está na pasta do jogo. Com o jogo rodando, a cada 2 s ele só
// pergunta ao Windows se esses processos ainda existem, o que não custa nada.
// Listar os processos (uns 250 ms) e ver o caminho de cada um (perto de 1 s)
// fica para quando eles somem, para enquanto o jogo ainda não abriu e para uma
// conferência por minuto.
const sessions = new Map();
const SESSION_POLL = 2000;

// O processo ainda existe? (Sinal 0 não mexe nele; EPERM = existe, mas é de outro usuário.)
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
const TWO_WEEKS = 14 * 24 * 60 * 60;
let sessionTimer = null;
let pollingSessions = false;

// Nomes dos executáveis dentro da pasta do jogo (sem instaladores e redistribuíveis).
function gameProcessNames(game) {
  const names = new Set();
  if (game.exe) names.add(path.basename(game.exe).toLowerCase());
  const folder = game.source === 'Manual' ? guessGameFolder(game) : game.folder;
  let budget = 4000; // pastas enormes: para de procurar
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (--budget < 0) return;
      if (entry.isDirectory()) {
        if (depth < 4) walk(path.join(dir, entry.name), depth + 1);
      } else if (/\.exe$/i.test(entry.name) && !/^(unins\d*|setup|install\w*|vc_?redist\S*|dxsetup|dotnet\S*|\S*redist\S*|\S*crash\S*)\.exe$/i.test(entry.name)) {
        names.add(entry.name.toLowerCase());
      }
    }
  };
  if (folder) walk(folder, 0);
  return names;
}

// Processos em execução: Map de PID -> nome do executável (tasklist é leve).
function runningProcesses() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const processes = new Map();
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (m) processes.set(Number(m[2]), m[1].toLowerCase());
      }
      resolve(err ? null : processes);
    });
  });
}

// Caminho do executável de cada processo: Map de PID -> caminho (null quando o
// Windows não deixa ver, como em jogo aberto como administrador). Leva perto de
// um segundo, então só é chamada quando precisa.
function processPaths() {
  return new Promise((resolve) => {
    const script = 'Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const paths = new Map();
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const cut = line.indexOf('|');
        if (cut > 0) paths.set(Number(line.slice(0, cut)), line.slice(cut + 1).trim().toLowerCase() || null);
      }
      resolve(err || !paths.size ? null : paths);
    });
  });
}

function watchSession(game) {
  if (sessions.has(game.id) || game.installed === false) return;
  const names = gameProcessNames(game);
  if (!names.size) return; // sem pasta conhecida não há como saber se está rodando
  const folder = game.source === 'Manual' ? guessGameFolder(game) : game.folder || (game.exe && path.dirname(game.exe));
  sessions.set(game.id, {
    names,
    folder: path.resolve(folder).toLowerCase() + path.sep,
    pids: new Set(),
    launchedAt: Date.now(),
    startedAt: null,
    lastSeen: 0,
    checkedAt: 0,
    verifiedAt: 0,
  });
  sessionTimer ??= setInterval(pollSessions, SESSION_POLL);
}

async function pollSessions() {
  if (pollingSessions) return;
  pollingSessions = true;
  try {
    let changed = false;
    // 1. Quem tem processos conhecidos e vivos não precisa de mais nada.
    const unsure = [];
    for (const [id, session] of sessions) {
      const now = Date.now();
      for (const pid of session.pids) if (!isAlive(pid)) session.pids.delete(pid);
      if (session.pids.size && now - session.verifiedAt < 60000) session.lastSeen = now;
      else unsure.push([id, session]);
    }

    // 2. Para os outros (ainda não abriu, os processos sumiram ou é hora de conferir), lista os processos.
    const processes = unsure.length ? await runningProcesses() : null;
    let paths; // caminhos: no máximo uma consulta por rodada, e só se alguém precisar
    for (const [id, session] of processes ? unsure : []) {
      const now = Date.now();
      // Um PID pode ter sido reaproveitado por outro programa: confere pelo nome.
      for (const pid of session.pids) if (!session.names.has(processes.get(pid))) session.pids.delete(pid);
      if (session.pids.size) {
        session.verifiedAt = now;
        session.lastSeen = now;
        continue;
      }
      // Nenhum conhecido. Há algum processo com nome de executável do jogo? Antes de
      // o jogo abrir, a confirmação pelo caminho roda no máximo a cada 10 s.
      const candidates = [...processes].filter(([, image]) => session.names.has(image));
      let checked = false;
      if (candidates.length && (session.startedAt || now - session.checkedAt >= 10000)) {
        session.checkedAt = now;
        checked = true;
        if (paths === undefined) paths = await processPaths();
        for (const [pid] of candidates) {
          // Sem a consulta (ou sem permissão para ver o caminho), vale o nome.
          const exe = paths ? paths.get(pid) : null;
          if (exe ? exe.startsWith(session.folder) : !paths || paths.has(pid)) session.pids.add(pid);
        }
        if (session.pids.size) {
          if (!session.startedAt) {
            session.startedAt = session.launchedAt;
            changed = true;
          }
          session.verifiedAt = Date.now();
          session.lastSeen = Date.now();
          continue;
        }
      }
      // Estava rodando e não sobrou nenhum processo dele (fechou), ou nunca chegou a abrir.
      if (session.startedAt ? !candidates.length || checked : now - session.launchedAt > 3 * 60 * 1000) {
        endSession(id);
        changed = true;
      }
    }
    if (!sessions.size) {
      clearInterval(sessionTimer);
      sessionTimer = null;
    }
    if (changed) notifyChanged();
  } finally {
    pollingSessions = false;
  }
}

// Fecha a sessão e guarda o tempo: no histórico recente (para o total das duas
// últimas semanas) e, fora da Steam, que já conta sozinha, no tempo de jogo.
function endSession(id) {
  const session = sessions.get(id);
  sessions.delete(id);
  if (!session || !session.startedAt) return;
  // Backup dos saves logo depois de fechar (alguns segundos, para o jogo terminar de gravar).
  if (autoBackup()) setTimeout(() => backupSaves(id, 'ao fechar o jogo').catch(() => {}), 5000);
  const seconds = Math.round((session.lastSeen - session.startedAt) / 1000);
  if (seconds < 20) return;
  const at = Math.round(session.lastSeen / 1000);
  const lib = getLibrary();
  lib.recent = lib.recent.filter((old) => at - old.at < 366 * 24 * 60 * 60);
  // O nome vai junto: o jogo pode sair da biblioteca depois, e as estatísticas continuam legíveis.
  lib.recent.push({ id, name: (games.get(id) || {}).name, at, seconds });
  const list = readManual();
  const entry = list.find((g) => g.id === id);
  if (entry) {
    entry.playSeconds = (entry.playSeconds || 0) + seconds;
    entry.lastPlayed = at;
    writeManual(list);
  } else if (!id.startsWith('steam:')) {
    lib.play[id] = { seconds: ((lib.play[id] || {}).seconds || 0) + seconds, lastPlayed: at };
  }
  saveLibrary();
}

// Minutos jogados nas duas últimas semanas: o que a Steam informa para os jogos
// dela (inclui o que foi aberto por fora) ou as sessões que o launcher viu.
let steamRecent = new Map(); // appid -> minutos, refeito a cada varredura
function recentMinutes(game) {
  const since = Date.now() / 1000 - TWO_WEEKS;
  const seen = getLibrary().recent.filter((s) => s.id === game.id && s.at >= since).reduce((sum, s) => sum + s.seconds, 0) / 60;
  return Math.round(Math.max(seen, steamRecent.get(String(game.appid)) || 0));
}

// Conquistas vindas da Web API da Steam, guardadas em disco por appid.
const ACHIEVEMENTS_MAX_AGE = 6 * 60 * 60 * 1000;
let achievementCache;
function getAchievementCache() {
  achievementCache ??= readJson(achievementsFile(), {});
  return achievementCache;
}

function achievementSummary(appid) {
  const entry = getAchievementCache()[appid];
  return entry && entry.data ? { unlocked: entry.data.unlocked, total: entry.data.total } : null;
}

async function webAchievements(appid) {
  const cache = getAchievementCache();
  const entry = cache[appid];
  const key = getSecret('steamKey');
  const id = key && await steamId();
  if (!id || (entry && Date.now() - entry.fetchedAt < ACHIEVEMENTS_MAX_AGE)) return entry ? entry.data : null;
  try {
    cache[appid] = { fetchedAt: Date.now(), data: await fetchAchievements(key, id, appid) };
    writeJson(achievementsFile(), cache);
    return cache[appid].data;
  } catch {
    return entry ? entry.data : null; // sem internet: fica com o que já tinha
  }
}

// Em segundo plano, busca as conquistas dos jogos já jogados que ainda não têm
// dados, para o resumo aparecer nos cards sem precisar abrir jogo por jogo.
let prefetching = false;
// Appids já consultados nesta sessão, com ou sem resposta. Sem isso, um jogo cuja
// consulta falha era tentado de novo a cada varredura, e cada rodada mandava a
// tela se refazer: um laço sem fim, com as capas piscando a cada segundo.
const achievementsTried = new Set();
async function prefetchAchievements() {
  if (prefetching || !getSecret('steamKey')) return;
  prefetching = true;
  let fetched = 0;
  try {
    for (const game of [...games.values()]) {
      if (game.source !== 'Steam' || game.achievements || !game.playtimeMinutes) continue;
      if (getAchievementCache()[game.appid] || achievementsTried.has(game.appid)) continue;
      achievementsTried.add(game.appid);
      await webAchievements(game.appid);
      await sleep(350);
      // Só conta (e avisa a tela) o que trouxe dados novos.
      if (getAchievementCache()[game.appid] && ++fetched % 10 === 0) notifyChanged();
    }
  } finally {
    prefetching = false;
    if (fetched % 10) notifyChanged();
  }
}

// ---------- Saves ----------

const savesRoot = () => readJson(settingsFile(), {}).savesDir || path.join(app.getPath('documents'), 'Ludex', 'Backups de saves');
const autoBackup = () => readJson(settingsFile(), {}).autoBackup !== false;
let saves;
function getSaves() {
  saves ??= new Saves({
    manifestFile: path.join(app.getPath('userData'), 'ludusavi-manifest.yaml'),
    root: savesRoot,
    documents: app.getPath('documents'),
  });
  return saves;
}

// O que o módulo de saves precisa saber de um jogo.
const SAVE_STORES = { Steam: 'steam', GOG: 'gog', Epic: 'epic', EA: 'origin', Ubisoft: 'uplay' };
async function saveTarget(game) {
  return {
    id: game.id,
    name: game.name,
    appid: game.appid || null,
    gogId: game.id.startsWith('gog:') ? game.id.slice(4) : null,
    store: SAVE_STORES[game.source] || null,
    folder: game.source === 'Manual' ? guessGameFolder(game) : game.folder || null,
    storeRoot: game.source === 'Steam' ? await findSteamPath() : null,
    custom: getLibrary().saveDirs[game.id] || null,
  };
}

async function backupSaves(id, reason) {
  const game = games.get(id);
  if (!game) return { ok: false, error: 'Jogo não encontrado.' };
  const result = await getSaves().backup(await saveTarget(game), reason);
  if (result.ok && !result.unchanged) {
    getLibrary().backups[id] = { at: result.at };
    saveLibrary();
    notifyChanged();
  }
  return result;
}

ipcMain.handle('saves:info', async (_event, id) => {
  const game = games.get(id);
  if (!game) return null;
  const target = await saveTarget(game);
  let located;
  try {
    located = await getSaves().locate(target);
  } catch (err) {
    located = { from: null, paths: [], error: err.message };
  }
  return { ...located, custom: Boolean(target.custom), backups: getSaves().list(target), root: getSaves().gameFolder(target) };
});

ipcMain.handle('saves:backup', async (_event, id) => {
  try {
    const result = await backupSaves(id, 'manual');
    if (result.unchanged) return { ok: true, message: 'Nada mudou desde o último backup.' };
    if (!result.ok) return result;
    return { ok: true, message: `Backup feito: ${result.files} ${result.files === 1 ? 'arquivo' : 'arquivos'}.` };
  } catch (err) {
    return { ok: false, error: `Não deu para fazer o backup: ${err.message}` };
  }
});

ipcMain.handle('saves:restore', async (_event, id, dir) => {
  const game = games.get(id);
  if (!game) return { ok: false, error: 'Jogo não encontrado.' };
  if (sessions.has(id)) return { ok: false, error: 'Feche o jogo antes de restaurar os saves.' };
  const target = await saveTarget(game);
  // Só aceita um backup que é deste jogo.
  if (!getSaves().list(target).some((backup) => path.resolve(backup.dir) === path.resolve(String(dir)))) return { ok: false, error: 'Backup não encontrado.' };
  try {
    const result = await getSaves().restore(target, dir);
    getLibrary().backups[id] = { at: Date.now() };
    saveLibrary();
    return { ok: true, message: `Saves restaurados (${result.files} ${result.files === 1 ? 'arquivo' : 'arquivos'}). O estado anterior ficou guardado como backup.` };
  } catch (err) {
    return { ok: false, error: `Não deu para restaurar: ${err.message}` };
  }
});

// Pasta de saves escolhida à mão (ou null para voltar a usar o catálogo).
ipcMain.handle('saves:pickFolder', async (event, id, clear) => {
  const game = games.get(id);
  if (!game) return false;
  const lib = getLibrary();
  if (clear) {
    delete lib.saveDirs[id];
  } else {
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: `Pasta dos saves de ${game.name}`,
      defaultPath: (lib.saveDirs[id] || [])[0] || app.getPath('documents'),
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return false;
    lib.saveDirs[id] = [picked.filePaths[0]];
  }
  saveLibrary();
  return true;
});

ipcMain.handle('saves:openFolder', async (_event, id) => {
  const game = games.get(id);
  const folder = game ? getSaves().gameFolder(await saveTarget(game)) : savesRoot();
  fs.mkdirSync(folder, { recursive: true });
  shell.openPath(folder);
});

ipcMain.handle('settings:pickSavesDir', async (event) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Pasta dos backups de saves',
    defaultPath: savesRoot(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths.length) return false;
  setSetting('savesDir', picked.filePaths[0]);
  return true;
});

ipcMain.handle('settings:setAutoBackup', (_event, on) => {
  setSetting('autoBackup', Boolean(on));
  return true;
});

// ---------- Estatísticas ----------

// Sessões registradas, com o nome do jogo (o jogo pode já ter saído da biblioteca).
ipcMain.handle('stats:get', () => {
  const manual = new Map(readManual().map((g) => [g.id, g.name]));
  return getLibrary().recent.map((session) => ({
    ...session,
    name: (games.get(session.id) || {}).name || session.name || manual.get(session.id) || 'Jogo removido',
  }));
});

// ---------- Tamanho no disco ----------

const SIZE_MAX_AGE = 24 * 60 * 60 * 1000;

// Soma dos arquivos de uma pasta, sem seguir atalhos de pasta (junções).
async function folderSize(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fs.promises.stat(full)).size;
        } catch {
          // Arquivo sumiu ou está bloqueado: fica de fora.
        }
      }
    }
  }
  return total;
}

// Mede, em segundo plano e um por vez, os jogos cuja loja não informa o tamanho.
// O resultado vale por um dia.
let measuring = false;
async function measureSizes() {
  if (measuring) return;
  measuring = true;
  const lib = getLibrary();
  let pending = 0;
  try {
    for (const game of [...games.values()]) {
      if (game.installed === false || game.size || sessions.has(game.id)) continue;
      const known = lib.sizes[game.id];
      if (known && Date.now() - known.at < SIZE_MAX_AGE) continue;
      const folder = game.source === 'Manual' ? guessGameFolder(game) : game.folder;
      if (!folder) continue;
      lib.sizes[game.id] = { bytes: await folderSize(folder), at: Date.now() };
      if (++pending >= 5) {
        pending = 0;
        saveLibrary();
        notifyChanged();
      }
    }
  } finally {
    measuring = false;
    if (pending) {
      saveLibrary();
      notifyChanged();
    }
  }
}

ipcMain.handle('games:list', async (_event, force) => {
  const list = await scanAll();
  enrich();
  measureSizes();
  refreshOwned(Boolean(force)).then((changed) => (changed ? notifyChanged() : prefetchAchievements()));
  refreshAccounts(Boolean(force)).then((changed) => changed && notifyChanged());
  return list;
});

ipcMain.handle('games:launch', async (_event, id) => {
  const game = games.get(id);
  if (!game) return { ok: false, error: 'Jogo não encontrado.' };
  try {
    if (game.launch.type === 'url') {
      await shell.openExternal(game.launch.target);
    } else if (!sessions.has(id)) {
      // Pelo shell do Windows, como um duplo clique no arquivo: é o que mostra o
      // pedido de administrador quando o jogo exige (abrir o processo direto
      // falhava nesses casos), e serve também para atalhos e arquivos .bat.
      const error = await shell.openPath(game.launch.target);
      if (error) return { ok: false, error: /cancel/i.test(error) ? 'A abertura foi cancelada.' : error };
    }
    watchSession(game);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('games:openFolder', (_event, id) => {
  const game = games.get(id);
  if (game && game.folder) shell.openPath(game.folder);
});

// Escolher um executável e acrescentá-lo à biblioteca; `defaultPath` é a pasta
// onde a janela de escolha abre (a de um download concluído, por exemplo).
ipcMain.handle('games:add', (event) => pickAndAddGame(BrowserWindow.fromWebContents(event.sender)));

async function pickAndAddGame(win, defaultPath) {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Escolha o executável do jogo',
    defaultPath,
    properties: ['openFile'],
    filters: [{ name: 'Executáveis', extensions: ['exe', 'lnk', 'bat'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return false;

  const exe = picked.filePaths[0];
  const list = readManual();
  if (!list.some((g) => g.exe.toLowerCase() === exe.toLowerCase())) {
    list.push({ id: `manual:${Date.now()}`, name: path.parse(exe).name, exe });
    writeManual(list);
  }
  return true;
}

// Troca o executável que abre o jogo (o certo quando o launcher pegou um
// instalador, um launcher intermediário ou a versão errada do jogo).
ipcMain.handle('games:changeExe', async (event, id) => {
  const game = games.get(id);
  if (!game || game.launch.type !== 'exe') return { ok: false, error: 'Este jogo é aberto pela loja dele, não por um executável.' };
  if (sessions.has(id)) return { ok: false, error: 'Feche o jogo antes de trocar o executável.' };
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: `Executável de ${game.name}`,
    defaultPath: path.dirname(game.launch.target),
    properties: ['openFile'],
    filters: [{ name: 'Executáveis', extensions: ['exe', 'lnk', 'bat'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false };
  const exe = picked.filePaths[0];
  if (exe.toLowerCase() === game.launch.target.toLowerCase()) return { ok: false };
  if (game.source === 'Manual') {
    const list = readManual();
    if (list.some((g) => g.id !== id && g.exe.toLowerCase() === exe.toLowerCase())) return { ok: false, error: 'Esse executável já é de outro jogo da biblioteca.' };
    const entry = list.find((g) => g.id === id);
    if (!entry) return { ok: false, error: 'Jogo não encontrado.' };
    entry.exe = exe;
    writeManual(list);
  } else {
    getLibrary().exes[id] = exe;
    saveLibrary();
  }
  return { ok: true, message: `${game.name} agora abre por ${path.basename(exe)}.` };
});

// ---------- Desinstalar ----------

// Pastas que nunca vão para a Lixeira, nem nada que as contenha.
function protectedFolders() {
  const env = process.env;
  return [
    app.getPath('home'), app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads'), app.getPath('userData'),
    env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, path.dirname(process.execPath),
  ].filter(Boolean).map((dir) => path.resolve(dir).toLowerCase());
}

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// Dá para mandar esta pasta para a Lixeira como "a pasta do jogo"? Precisa conter
// o executável e não ser (nem conter) uma pasta do sistema ou do usuário.
function safeGameFolder(folder, exe) {
  folder = path.resolve(folder);
  if (path.parse(folder).root === folder || !isInside(exe, folder)) return false;
  return !protectedFolders().some((dir) => isInside(dir, folder.toLowerCase()));
}

// Palpite para a pasta raiz de um jogo manual: a mais alta, até quatro níveis
// acima do executável, cujo nome contém o nome do jogo ("E:\\Jogos\\Crusader
// Kings III\\binaries\\ck3.exe" -> "E:\\Jogos\\Crusader Kings III"). Sem nenhuma, a do executável.
function guessGameFolder(game) {
  const simple = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = [game.name, path.parse(game.exe).name].map(simple).filter((name) => name.length >= 3);
  let best = path.dirname(game.exe);
  for (let dir = best, level = 0; level < 4; level++, dir = path.dirname(dir)) {
    if (names.some((name) => simple(path.basename(dir)).includes(name)) && safeGameFolder(dir, game.exe)) best = dir;
    if (path.dirname(dir) === dir) break;
  }
  return best;
}

// Acha o desinstalador de verdade de um jogo, nesta ordem:
//   1. o registrado no Windows cuja pasta de instalação contém o jogo;
//   2. um arquivo de desinstalador na pasta do jogo (unins000.exe, uninstall.exe...);
//   3. o registrado no Windows com exatamente o nome do jogo.
// Devolve { command } (a linha de comando a executar) ou null se o jogo não tem desinstalador.
async function findUninstaller(game) {
  const target = game.exe || game.folder;
  if (!target) return null;
  const simple = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const registered = await registeredUninstallers().catch(() => []);

  const around = registered
    .filter((entry) => entry.location && path.parse(entry.location).root.replace(/[\\/]$/, '') !== entry.location)
    .filter((entry) => isInside(target, entry.location) && path.relative(entry.location, target).split(path.sep).length <= 5)
    .sort((x, y) => y.location.length - x.location.length);
  if (around.length) return { command: around[0].command };

  // Da pasta do executável até a raiz do jogo; nas lojas, só a pasta de instalação.
  const top = game.source === 'Manual' ? guessGameFolder(game) : game.folder || path.dirname(target);
  for (let dir = game.exe ? path.dirname(game.exe) : top; isInside(dir, top); dir = path.dirname(dir)) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      // Pasta ilegível: tenta a de cima.
    }
    const file = files.find((name) => /^(unins\d*|uninst\w*|uninstall[\w .-]*)\.exe$/i.test(name));
    if (file) return { command: `"${path.join(dir, file)}"` };
    if (path.dirname(dir) === dir) break;
  }

  const byName = registered.find((entry) => simple(entry.name) === simple(game.name));
  return byName ? { command: byName.command } : null;
}

function removeFromLibrary(id) {
  writeManual(readManual().filter((g) => g.id !== id));
  const lib = getLibrary();
  delete lib.matches[id];
  delete lib.covers[id];
  delete lib.sgdb[id];
  for (const category of lib.categories) category.games = category.games.filter((g) => g !== id);
  lib.hidden = lib.hidden.filter((g) => g !== id);
  delete lib.play[id];
  saveLibrary();
}

// Jogo manual sem desinstalador nenhum (só copiado para uma pasta): não há o que
// "desinstalar" além de apagar a pasta, então ela vai para a Lixeira, de onde dá para restaurar.
async function trashManual(win, game) {
  let folder = guessGameFolder(game);
  for (;;) {
    const safe = safeGameFolder(folder, game.exe);
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `${game.name} não tem desinstalador`,
      detail: (safe
        ? `Não achei desinstalador para este jogo, nem no Windows nem na pasta dele: ele foi só copiado para o disco. Para removê-lo, esta pasta, com tudo o que há dentro, vai para a Lixeira:\n\n${folder}\n\nSe não for a pasta do jogo, escolha outra.`
        : `Não achei desinstalador para este jogo, e o executável está em uma pasta que o launcher não apaga por segurança:\n\n${folder}\n\nEscolha a pasta do jogo, ou só tire-o da biblioteca.`),
      buttons: [...(safe ? ['Mover para a Lixeira'] : []), 'Escolher outra pasta...', 'Só tirar da biblioteca', 'Cancelar'],
      defaultId: safe ? 3 : 2,
      cancelId: safe ? 3 : 2,
    });
    const choice = answer.response + (safe ? 0 : 1); // 0 lixeira, 1 outra pasta, 2 só tirar, 3 cancelar
    if (choice === 3) return { ok: false };
    if (choice === 2) {
      removeFromLibrary(game.id);
      return { ok: true, removed: true, message: 'Jogo tirado da biblioteca; os arquivos continuam no disco.' };
    }
    if (choice === 1) {
      const picked = await dialog.showOpenDialog(win, { title: 'Pasta do jogo', defaultPath: folder, properties: ['openDirectory'] });
      if (picked.canceled || !picked.filePaths.length) continue;
      if (!isInside(game.exe, picked.filePaths[0])) {
        await dialog.showMessageBox(win, { type: 'error', message: 'Essa pasta não contém o executável do jogo.', detail: game.exe });
        continue;
      }
      folder = picked.filePaths[0];
      continue;
    }
    try {
      await shell.trashItem(folder);
    } catch {
      return { ok: false, error: 'Não deu para mover a pasta para a Lixeira. Feche o jogo e qualquer programa usando os arquivos; se a pasta for grande demais para a Lixeira, apague-a pelo Explorador.' };
    }
    removeFromLibrary(game.id);
    return { ok: true, removed: true, message: `${game.name} foi para a Lixeira.` };
  }
}

// Desinstalar é sempre pelo desinstalador de verdade: o da loja (Steam, Ubisoft),
// o que a loja ou o instalador registrou (GOG, EA, repacks) ou o que está na
// pasta do jogo. O launcher só o encontra e dispara.
ipcMain.handle('games:uninstall', async (event, id) => {
  const game = games.get(id);
  if (!game || game.installed === false) return { ok: false, error: 'Jogo não encontrado.' };
  if (sessions.has(id)) return { ok: false, error: 'Feche o jogo antes de desinstalar.' };
  const win = BrowserWindow.fromWebContents(event.sender);
  const how = game.uninstall;
  try {
    if (how && how.type === 'url') {
      await shell.openExternal(how.target);
      return { ok: true, message: `A ${game.source} vai pedir a confirmação da desinstalação.` };
    }
    const found = how && how.type === 'command' ? { command: how.target } : await findUninstaller(game);
    if (found) {
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        message: `Desinstalar ${game.name}?`,
        detail: `O desinstalador do jogo vai abrir e cuidar da remoção:\n\n${found.command}`,
        buttons: ['Abrir o desinstalador', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
      });
      if (answer.response !== 0) return { ok: false };
      // Linha de comando inteira, como está no registro do Windows.
      spawn(found.command, { shell: true, detached: true, stdio: 'ignore' }).unref();
      return { ok: true, message: 'Desinstalador do jogo aberto. O jogo sai da lista quando ele terminar.' };
    }
    if (how && how.type === 'client') {
      await shell.openExternal(how.target);
      return { ok: true, message: `A ${game.source} só desinstala por dentro do launcher dela: abri o ${how.client}; na biblioteca, clique nos três pontos do jogo e em Desinstalar.` };
    }
    if (game.source === 'Manual') return trashManual(win, game);
    return { ok: false, error: `Não achei o desinstalador deste jogo. Desinstale pelo launcher da ${game.source}.` };
  } catch (err) {
    return { ok: false, error: `Não deu para abrir a desinstalação: ${err.message}` };
  }
});

ipcMain.handle('games:remove', (_event, id) => {
  removeFromLibrary(id);
  return true;
});

// Resultados da loja da Steam e, com chave configurada, do SteamGridDB.
ipcMain.handle('games:search', async (_event, term) => {
  term = String(term).slice(0, 100);
  const key = getSgdbKey();
  const [steam, grid] = await Promise.allSettled([searchStore(term), key ? sgdb.searchGames(key, term) : []]);
  const items = [
    ...(steam.value || []).map((i) => ({ provider: 'steam', ref: i.appid, name: i.name, image: i.image })),
    ...(grid.value || []).map((i) => ({ provider: 'sgdb', ref: i.ref, name: i.name, image: null })),
  ];
  return { ok: steam.status === 'fulfilled' || grid.status === 'fulfilled', items };
});

ipcMain.handle('games:achievements', async (_event, id) => {
  const game = games.get(id);
  if (!game || game.source !== 'Steam') return null;
  const steamPath = await findSteamPath();
  const local = steamPath && readAchievements(steamPath, game.appid);
  if (local) return local;
  // Sem cache local (jogo não instalado): Web API. Se o resumo mudou, avisa a tela.
  const before = JSON.stringify(achievementSummary(game.appid));
  const data = await webAchievements(game.appid);
  if (JSON.stringify(achievementSummary(game.appid)) !== before) notifyChanged();
  return data;
});

// Cor de destaque do jogo: analisa a primeira capa que carregar e guarda o resultado.
ipcMain.handle('games:accent', async (_event, id) => {
  const game = games.get(id);
  if (!game) return null;
  const lib = getLibrary();
  for (const url of game.covers) {
    if (url in lib.colors) return lib.colors[url];
    let image = null;
    try {
      if (url.startsWith('file:')) {
        image = nativeImage.createFromPath(fileURLToPath(url));
      } else {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
      }
    } catch {
      // Capa indisponível: tenta a próxima.
    }
    if (!image || image.isEmpty()) continue;
    // Miniatura basta para achar a cor e deixa a conta instantânea.
    lib.colors[url] = dominantColor(image.resize({ width: 48, height: 72, quality: 'good' }).toBitmap());
    saveLibrary();
    return lib.colors[url];
  }
  return null;
});

ipcMain.handle('games:setHidden', (_event, id, hidden) => {
  if (!games.has(id)) return false;
  const lib = getLibrary();
  lib.hidden = lib.hidden.filter((g) => g !== id);
  if (hidden) lib.hidden.push(id);
  saveLibrary();
  return true;
});

// Categorias: valem para qualquer jogo, instalado ou não.
const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);

function findOrCreateCategory(name) {
  const lib = getLibrary();
  let category = lib.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!category) {
    category = { id: `cat:${Date.now()}:${lib.categories.length}`, name, games: [] };
    lib.categories.push(category);
  }
  return category;
}

ipcMain.handle('categories:list', () => getLibrary().categories.map(({ id, name }) => ({ id, name })));

ipcMain.handle('categories:create', (_event, name) => {
  name = cleanName(name);
  if (!name) return null;
  const category = findOrCreateCategory(name);
  saveLibrary();
  return category.id;
});

ipcMain.handle('categories:rename', (_event, id, name) => {
  name = cleanName(name);
  const lib = getLibrary();
  const category = lib.categories.find((c) => c.id === id);
  // Não deixa duas categorias com o mesmo nome.
  if (!category || !name || lib.categories.some((c) => c !== category && c.name.toLowerCase() === name.toLowerCase())) return false;
  category.name = name;
  saveLibrary();
  return true;
});

ipcMain.handle('categories:delete', (_event, id) => {
  const lib = getLibrary();
  lib.categories = lib.categories.filter((c) => c.id !== id);
  saveLibrary();
  return true;
});

ipcMain.handle('categories:setGame', (_event, id, gameId, on) => {
  const category = getLibrary().categories.find((c) => c.id === id);
  if (!category || !games.has(gameId)) return false;
  category.games = category.games.filter((g) => g !== gameId);
  if (on) category.games.push(gameId);
  saveLibrary();
  return true;
});

// Traz as coleções da biblioteca da Steam como categorias (junta com as de mesmo nome).
ipcMain.handle('categories:importSteam', async () => {
  const steamPath = await findSteamPath();
  const { collections, hidden } = steamPath ? readSteamCollections(steamPath) : { collections: [], hidden: [] };
  const lib = getLibrary();
  for (const collection of collections) {
    const category = findOrCreateCategory(cleanName(collection.name));
    category.games = [...new Set([...category.games, ...collection.appids.map((appid) => `steam:${appid}`)])];
  }
  // Os jogos ocultos na Steam ficam ocultos aqui também.
  lib.hidden = [...new Set([...lib.hidden, ...hidden.map((appid) => `steam:${appid}`)])];
  saveLibrary();
  return { collections: collections.length, hidden: hidden.length };
});

ipcMain.handle('settings:get', async () => {
  const hasSteamKey = Boolean(getSecret('steamKey'));
  const owned = getLibrary().owned;
  return {
    hasSgdbKey: Boolean(getSgdbKey()),
    hasSteamKey,
    steamId: await steamId(),
    ownedCount: hasSteamKey && owned ? owned.games.length : null,
    accounts: accountStatus(),
    downloadDir: downloadDir(),
    closeToTray: closeToTray(),
    savesDir: savesRoot(),
    autoBackup: autoBackup(),
    canOpenAtLogin: app.isPackaged,
    openAtLogin: app.isPackaged && app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,
    hasRdToken: Boolean(getSecret('rdToken')),
    rdUser: readJson(settingsFile(), {}).rdUser || null,
  };
});

ipcMain.handle('settings:setSteamKey', async (_event, key) => {
  key = String(key || '').trim();
  const lib = getLibrary();
  if (key) {
    const id = await steamId();
    if (!id) return { ok: false, error: 'Não achei uma conta da Steam neste computador. Abra a Steam e entre na sua conta.' };
    try {
      lib.owned = { steamId: id, fetchedAt: Date.now(), games: await fetchOwnedGames(key, id) };
    } catch (err) {
      return { ok: false, error: err.auth ? err.message : 'Não deu para falar com a Steam. Confira a internet.' };
    }
  } else {
    lib.owned = null;
  }
  setSecret('steamKey', key || null);
  saveLibrary();
  notifyChanged();
  return { ok: true };
});

// ---------- Contas GOG e Epic ----------

const expiredAccounts = new Set(); // lojas cujo login deixou de valer

// Token de acesso válido da loja, renovando com o refresh token quando vence.
async function accountToken(store) {
  const saved = getSecret(`${store}Auth`);
  if (!saved) return null;
  let auth = JSON.parse(saved);
  if (auth.expires < Date.now() + 60000) {
    auth = await storeAccounts[store].refresh(auth);
    setSecret(`${store}Auth`, JSON.stringify(auth));
  }
  return auth.access;
}

async function refreshAccount(store) {
  const lib = getLibrary();
  try {
    const token = await accountToken(store);
    if (!token) return false;
    const known = lib.accounts[store] ? lib.accounts[store].games : [];
    lib.accounts[store] = { fetchedAt: Date.now(), games: await storeAccounts[store].library(token, known) };
    expiredAccounts.delete(store);
    saveLibrary();
    return true;
  } catch (err) {
    if (err.auth) expiredAccounts.add(store);
    return false; // sem internet ou sessão vencida: fica com a lista guardada
  }
}

// Atualiza as contas conectadas, no máximo uma vez por hora (ou quando forçado).
async function refreshAccounts(force) {
  let changed = false;
  for (const store of Object.keys(storeAccounts)) {
    const saved = getLibrary().accounts[store];
    if (!getSecret(`${store}Auth`) || (!force && saved && Date.now() - saved.fetchedAt < OWNED_MAX_AGE)) continue;
    changed = (await refreshAccount(store)) || changed;
  }
  return changed;
}

function accountStatus() {
  const lib = getLibrary();
  const status = {};
  for (const store of Object.keys(storeAccounts)) {
    const connected = Boolean(getSecret(`${store}Auth`));
    status[store] = {
      connected,
      expired: expiredAccounts.has(store),
      count: connected && lib.accounts[store] ? lib.accounts[store].games.length : null,
    };
  }
  // Ubisoft e EA não têm login: valem os jogos achados neste computador.
  for (const [store, source] of [['ubisoft', 'Ubisoft'], ['ea', 'EA']]) {
    status[store] = { count: [...games.values()].filter((g) => g.source === source).length };
  }
  return status;
}

// Abre a página de login da loja numa janela separada e devolve o código de
// autorização (ou null se a janela for fechada antes).
function openLogin(parent, account) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 540,
      height: 780,
      title: `Entrar na ${account.name}`,
      autoHideMenuBar: true,
      backgroundColor: '#0a0a0a',
      webPreferences: {
        // Sessão descartável: os cookies do login somem quando a janela fecha.
        partition: `login-${Date.now()}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let finished = false;
    const done = (code) => {
      if (finished) return;
      finished = true;
      resolve(code);
      if (!win.isDestroyed()) win.close();
    };
    // As páginas de login recusam navegadores embutidos; apresenta-se como o Chrome que é.
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ (Electron|game-launcher)\/\S+/gi, ''));
    win.webContents.on('page-title-updated', (event) => event.preventDefault());
    account.capture(win.webContents, done);
    win.on('closed', () => done(null));
    win.loadURL(account.loginUrl);
  });
}

ipcMain.handle('accounts:connect', async (event, store) => {
  const account = storeAccounts[store];
  if (!account) return { ok: false, error: 'Loja desconhecida.' };
  const code = await openLogin(BrowserWindow.fromWebContents(event.sender), account);
  if (!code) return { ok: false, error: 'Login cancelado.' };
  try {
    setSecret(`${store}Auth`, JSON.stringify(await account.exchange(code)));
  } catch (err) {
    return { ok: false, error: `A ${account.name} recusou o login: ${err.message}` };
  }
  expiredAccounts.delete(store);
  const fetched = await refreshAccount(store);
  notifyChanged();
  return fetched ? { ok: true } : { ok: false, error: 'Conectou, mas não deu para baixar a lista de jogos. Tente "Atualizar".' };
});

ipcMain.handle('accounts:disconnect', (_event, store) => {
  if (!storeAccounts[store]) return false;
  setSecret(`${store}Auth`, null);
  delete getLibrary().accounts[store];
  expiredAccounts.delete(store);
  saveLibrary();
  notifyChanged();
  return true;
});

ipcMain.handle('settings:openSteamKeyPage', () => {
  shell.openExternal('https://steamcommunity.com/dev/apikey');
});

ipcMain.handle('settings:setSgdbKey', async (_event, key) => {
  key = String(key || '').trim();
  if (key) {
    try {
      await sgdb.searchGames(key, 'portal'); // só para validar a chave
    } catch (err) {
      return { ok: false, error: err.auth ? err.message : 'Não deu para falar com o SteamGridDB. Confira a internet.' };
    }
  }
  setSgdbKey(key || null);
  // Libera nova tentativa para quem tinha ficado sem capa.
  const lib = getLibrary();
  for (const [id, value] of Object.entries(lib.sgdb)) if (value === null) delete lib.sgdb[id];
  for (const item of [...failed]) if (String(item).startsWith('sgdb:')) failed.delete(item);
  saveLibrary();
  enrich();
  return { ok: true };
});

ipcMain.handle('settings:openSgdbKeyPage', () => {
  shell.openExternal('https://www.steamgriddb.com/profile/preferences/api');
});

function renameManual(id, name) {
  const list = readManual();
  const entry = list.find((g) => g.id === id);
  if (!entry || !name) return;
  entry.name = String(name).trim().slice(0, 120) || entry.name;
  writeManual(list);
}

// Define a qual jogo este corresponde: da loja da Steam (capa e informações),
// do SteamGridDB (só capa) ou nenhum (provider null).
ipcMain.handle('games:setMatch', async (_event, id, provider, ref, name) => {
  const game = games.get(id);
  if (!game || game.source === 'Steam') return false;
  if (provider && !/^\d+$/.test(String(ref))) return false;
  const lib = getLibrary();
  if (provider === 'steam') {
    lib.matches[id] = String(ref);
    delete lib.sgdb[id];
  } else if (provider === 'sgdb') {
    const key = getSgdbKey();
    if (!key) return false;
    try {
      lib.sgdb[id] = { gameId: String(ref), name, covers: await sgdb.gridUrls(key, ref) };
    } catch {
      return false;
    }
    lib.matches[id] = null;
  } else {
    lib.matches[id] = null;
    lib.sgdb[id] = null;
  }
  saveLibrary();
  renameManual(id, name);
  return true;
});

ipcMain.handle('games:rename', (_event, id, name) => {
  renameManual(id, name);
  return true;
});

ipcMain.handle('games:pickCover', async (event, id) => {
  if (!games.has(id)) return false;
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Escolha a imagem da capa',
    properties: ['openFile'],
    filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return false;
  getLibrary().covers[id] = picked.filePaths[0];
  saveLibrary();
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 520,
    minHeight: 400,
    backgroundColor: '#0a0a0a',
    // Sem a barra do Windows: minimizar/maximizar/fechar ficam na barra do próprio app.
    frame: false,
    autoHideMenuBar: true,
    title: 'Ludex',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const sendState = () => win.webContents.send('window:maximized', win.isMaximized());
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  // Voltou a aparecer: manda o estado atual dos downloads, que não chega com a janela minimizada.
  const sync = () => downloads && win.webContents.send('downloads:update', downloads.list(), downloads.history());
  win.on('restore', sync);
  win.on('show', sync);
  // Fechar com a bandeja ligada: a janela é destruída (isso libera a memória dela)
  // e o launcher segue na bandeja, só com o processo principal cuidando dos downloads.
  win.on('close', () => {
    if (!staysInTray()) return;
    if (!readJson(settingsFile(), {}).trayNotice) {
      setSetting('trayNotice', true);
      tray.displayBalloon({ title: 'Ludex', content: 'O Ludex continua aberto na bandeja, com os downloads andando. Para sair de vez, clique com o botão direito no ícone.' });
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
ipcMain.handle('window:minimize', (event) => senderWindow(event).minimize());
ipcMain.handle('window:close', (event) => senderWindow(event).close());
ipcMain.handle('window:isMaximized', (event) => senderWindow(event).isMaximized());
ipcMain.handle('window:setFullScreen', (event, on) => senderWindow(event).setFullScreen(Boolean(on)));
ipcMain.handle('window:toggleMaximize', (event) => {
  const win = senderWindow(event);
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

// ---------- Segundo plano (bandeja) ----------

let tray = null;
let exiting = false; // saindo de verdade (menu da bandeja, instalador), não só fechando a janela
const closeToTray = () => readJson(settingsFile(), {}).closeToTray !== false;
// Fechar a janela mantém o app aberto na bandeja?
const staysInTray = () => Boolean(tray) && !exiting && closeToTray();

function showWindow() {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) {
    createWindow(); // estava só na bandeja
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    tray = new Tray(appIcon);
  } catch {
    return; // sem bandeja, fechar a janela encerra o app como antes
  }
  tray.setToolTip('Ludex');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir o Ludex', click: showWindow },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

// Aviso do Windows para o que acontece com a janela escondida ou minimizada.
function notifyBackground(title, body) {
  const [win] = BrowserWindow.getAllWindows();
  if ((win && win.isVisible() && !win.isMinimized()) || !Notification.isSupported()) return;
  const note = new Notification({ title, body });
  note.on('click', showWindow);
  note.show();
}

// Abrir junto com o Windows. Só no app instalado: rodando pelo código-fonte, o
// executável seria o do Electron, sem o app.
const LOGIN_ARGS = ['--hidden'];
ipcMain.handle('settings:setOpenAtLogin', (_event, on) => {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: Boolean(on), args: LOGIN_ARGS });
  return true;
});

ipcMain.handle('settings:setCloseToTray', (_event, on) => {
  setSetting('closeToTray', Boolean(on));
  return true;
});

// ---------- Downloads ----------

// Configurações que não são segredo (pasta de downloads, nome da conta do Real-Debrid).
function setSetting(name, value) {
  const settings = readJson(settingsFile(), {});
  if (value === null) delete settings[name];
  else settings[name] = value;
  writeJson(settingsFile(), settings);
}

const downloadDir = () => readJson(settingsFile(), {}).downloadDir || app.getPath('downloads');

let downloads;
function getDownloads() {
  if (!downloads) {
    downloads = new Downloads({
      file: path.join(app.getPath('userData'), 'downloads.json'),
      torrentsDir: path.join(app.getPath('userData'), 'torrents'),
      defaultDir: downloadDir,
      rdToken: () => getSecret('rdToken'),
    });
    downloads.on('update', (list, history) => {
      // Janela minimizada não precisa redesenhar a cada segundo; ao voltar ela recebe o estado atual.
      for (const win of BrowserWindow.getAllWindows()) if (!win.isMinimized()) win.webContents.send('downloads:update', list, history);
      if (!tray) return;
      const active = list.filter((d) => d.status === 'preparing' || d.status === 'downloading');
      const speed = active.reduce((sum, d) => sum + (d.speed || 0), 0) / 1024 ** 2;
      tray.setToolTip(active.length
        ? `Ludex · ${active.length} ${active.length === 1 ? 'download' : 'downloads'} · ${speed.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB/s`
        : 'Ludex');
    });
    downloads.on('done', (item) => notifyBackground('Download concluído', item.name));
    downloads.on('choose', (item) => notifyBackground('Escolha os arquivos do torrent', item.name));
  }
  return downloads;
}

ipcMain.handle('downloads:list', () => getDownloads().list());
ipcMain.handle('downloads:history', () => getDownloads().history());

// `text` é o que o usuário colou: um link magnet ou uma URL http(s).
ipcMain.handle('downloads:add', (_event, { text, useRd }) => {
  text = String(text || '').trim();
  try {
    getDownloads().add({ magnet: text, url: text, useRd: Boolean(useRd) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('downloads:addTorrentFile', async (event, { useRd }) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Escolha o arquivo .torrent',
    properties: ['openFile'],
    filters: [{ name: 'Torrent', extensions: ['torrent'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false };
  try {
    getDownloads().add({ torrentFile: picked.filePaths[0], useRd: Boolean(useRd) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('downloads:files', (_event, id) => getDownloads().fileList(id));
ipcMain.handle('downloads:selectFiles', (_event, id, indexes) => getDownloads().selectFiles(id, Array.isArray(indexes) ? indexes : []));
ipcMain.handle('downloads:pause', (_event, id) => getDownloads().pause(id));
ipcMain.handle('downloads:resume', (_event, id) => getDownloads().resume(id));
ipcMain.handle('downloads:remove', (_event, id) => getDownloads().remove(id));

ipcMain.handle('downloads:openFolder', (_event, id) => {
  const item = getDownloads().list().find((d) => d.id === id);
  if (!item) return;
  if (item.path && fs.existsSync(item.path)) shell.showItemInFolder(item.path);
  else shell.openPath(item.dir);
});

// Download concluído: escolher o executável dentro da pasta dele e pôr na biblioteca.
ipcMain.handle('downloads:addToLibrary', (event, id) => {
  const item = getDownloads().list().find((d) => d.id === id);
  if (!item) return false;
  let folder = item.dir;
  try {
    if (item.path) folder = fs.statSync(item.path).isDirectory() ? item.path : path.dirname(item.path);
  } catch {
    // Arquivo movido ou apagado: abre na pasta de downloads.
  }
  return pickAndAddGame(BrowserWindow.fromWebContents(event.sender), folder);
});

// ---------- Fontes de download ----------

let sources;
function getSources() {
  sources ??= new Sources({
    file: path.join(app.getPath('userData'), 'sources.json'),
    dir: path.join(app.getPath('userData'), 'sources'),
  });
  return sources;
}

function notifySources() {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('sources:changed');
}

const sourceResult = (action) => action.then(() => ({ ok: true }), (err) => ({
  ok: false,
  error: err.name === 'TimeoutError' ? 'O servidor da fonte não respondeu.' : err.cause ? 'Não deu para falar com o servidor da fonte.' : err.message,
}));

ipcMain.handle('sources:list', () => {
  getSources().refreshStale().then((changed) => changed && notifySources());
  return getSources().list();
});

ipcMain.handle('sources:addUrl', (_event, url) => sourceResult(getSources().add({ url: String(url || '').trim() })));

ipcMain.handle('sources:addFile', async (event) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Escolha o arquivo .json da fonte',
    properties: ['openFile'],
    filters: [{ name: 'Fonte', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false };
  return sourceResult(getSources().add({ file: picked.filePaths[0] }));
});

ipcMain.handle('sources:refresh', (_event, id) => sourceResult(getSources().refresh(id)));
ipcMain.handle('sources:remove', (_event, id) => getSources().remove(id));
ipcMain.handle('sources:search', (_event, term, only) => getSources().search(String(term || '').slice(0, 100), Array.isArray(only) ? only : []));

// Põe na fila um link de uma fonte. Link para um .torrent: baixa o arquivo e
// entra como torrent, em vez de salvar o .torrent em si.
async function addLink(link, useRd, name) {
  let torrent = false;
  try {
    torrent = /^https?:\/\//i.test(link) && /\.torrent$/i.test(new URL(link).pathname);
  } catch {
    // Link malformado: o gerenciador recusa com a mensagem dele.
  }
  if (!torrent) return getDownloads().add({ magnet: link, url: link, useRd, name });
  const res = await fetch(link, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`O servidor respondeu HTTP ${res.status} ao buscar o .torrent.`);
  const temp = path.join(app.getPath('temp'), `game-launcher-${Date.now()}.torrent`);
  fs.writeFileSync(temp, Buffer.from(await res.arrayBuffer()));
  try {
    return getDownloads().add({ torrentFile: temp, useRd, name });
  } finally {
    fs.rmSync(temp, { force: true }); // o gerenciador já guardou a cópia dele
  }
}

// O renderer manda só a posição do item; o link sai do que está guardado da
// fonte. O título confere se a fonte não mudou desde a busca.
ipcMain.handle('sources:download', (_event, { source, index, title, useRd }) => {
  const entry = getSources().entry(source, index);
  if (!entry || entry.title !== title) return { ok: false, error: 'A fonte mudou desde a busca. Busque de novo.' };
  return sourceResult(addLink(entry.uris[0], Boolean(useRd), entry.title));
});

ipcMain.handle('settings:pickDownloadDir', async (event) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Pasta padrão dos downloads',
    defaultPath: downloadDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths.length) return false;
  setSetting('downloadDir', picked.filePaths[0]);
  return true;
});

ipcMain.handle('settings:setRdToken', async (_event, token) => {
  token = String(token || '').trim();
  if (!token) {
    setSecret('rdToken', null);
    setSetting('rdUser', null);
    return { ok: true };
  }
  let user;
  try {
    user = await realDebrid.user(token);
  } catch (err) {
    return { ok: false, error: err.auth ? err.message : 'Não deu para falar com o Real-Debrid. Confira a internet.' };
  }
  setSecret('rdToken', token);
  const until = user.expiration ? new Date(user.expiration).toLocaleDateString('pt-BR') : null;
  setSetting('rdUser', user.type === 'premium' ? `${user.username} · premium${until ? ` até ${until}` : ''}` : `${user.username} · sem assinatura ativa`);
  return { ok: true };
});

ipcMain.handle('settings:openRdTokenPage', () => {
  shell.openExternal('https://real-debrid.com/apitoken');
});

app.whenReady().then(() => {
  if (!primaryInstance) return;
  app.setAppUserModelId('local.gamelauncher.app'); // sem isso o Windows não mostra as notificações
  createTray();
  // Aberto pelo Windows ao entrar (--hidden): fica só na bandeja, se ela existir e estiver ligada.
  if (!process.argv.includes('--hidden') || !tray || !closeToTray()) createWindow();
  // Retoma o que estava baixando quando o app foi fechado.
  getDownloads().resumeInterrupted();
});
app.on('window-all-closed', () => {
  if (!staysInTray()) app.quit();
});
// Fechou o launcher com jogo aberto: salva o tempo contado até aqui.
let quitting = false;
app.on('before-quit', (event) => {
  exiting = true;
  for (const id of [...sessions.keys()]) endSession(id);
  // O motor de torrent precisa fechar as conexões antes de o processo sair;
  // segura a saída até ele terminar (no máximo 4 s).
  if (downloads && !quitting) {
    quitting = true;
    event.preventDefault();
    Promise.race([downloads.destroy(), new Promise((resolve) => setTimeout(resolve, 4000))])
      .catch(() => {})
      .finally(() => app.quit());
  }
});

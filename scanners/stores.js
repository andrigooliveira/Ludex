// Jogos instalados pela GOG, Ubisoft Connect e EA App, lidos do registro do
// Windows (é onde os três registram as instalações). Só enxerga o que está
// instalado: nenhuma dessas lojas tem API pública para a biblioteca da conta.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const UNINSTALL = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// Lê uma chave do registro com todas as subchaves: Map de caminho -> { nome: valor }.
function regTree(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/s'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? new Map() : parseReg(stdout));
    });
  });
}

function parseReg(output) {
  const tree = new Map();
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      current = {};
      tree.set(line.trim(), current);
    } else if (current) {
      const m = line.match(/^ {4}(.+?) {4}REG_\w+ {4}(.*)$/);
      if (m) current[m[1]] = m[2];
    }
  }
  return tree;
}

const lastPart = (key) => key.slice(key.lastIndexOf('\\') + 1);
const isDir = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

// GOG: cada jogo tem nome, pasta e executável no registro; dá para abrir sem o Galaxy.
async function scanGog() {
  const tree = await regTree('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games');
  const games = [];
  for (const [key, values] of tree) {
    // DLCs apontam para o jogo base em dependsOn.
    if (!values.gameName || !values.exe || values.dependsOn || !fs.existsSync(values.exe)) continue;
    games.push({
      id: `gog:${values.gameID || lastPart(key)}`,
      name: values.gameName,
      source: 'GOG',
      ready: true,
      exe: values.exe,
      folder: values.path || path.dirname(values.exe),
      launch: { type: 'exe', target: values.exe },
      // O instalador da GOG registra o desinstalador do jogo.
      uninstall: values.uninstallCommand ? { type: 'command', target: values.uninstallCommand } : null,
    });
  }
  return games;
}

// Lê um varint de protobuf: devolve [valor, próxima posição].
function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80) || pos >= buf.length) return [value, pos];
    shift += 7;
  }
}

// Percorre os campos de uma mensagem protobuf: chama onField(número, valor),
// onde valor é um número (varint) ou um Buffer (campo com tamanho).
function eachField(buf, onField) {
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const wire = tag & 7;
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      onField(tag >>> 3, value);
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      onField(tag >>> 3, buf.subarray(pos, pos + length));
      pos += length;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      return; // formato desconhecido: para por aqui
    }
  }
}

// Nome do jogo dentro da configuração (YAML) de um produto da Ubisoft. O nome
// pode ser direto ou uma chave traduzida em "localizations".
function ubisoftName(yaml) {
  const m = yaml.match(/^ {2}name: *(.+)$/m);
  if (!m) return null;
  let name = m[1].trim().replace(/^["']|["']$/g, '');
  const localizations = yaml.indexOf('\nlocalizations:');
  if (localizations >= 0 && /^[\w.-]+$/.test(name)) {
    const translated = yaml.slice(localizations).match(new RegExp('^ +' + name + ': *(.+)$', 'm'));
    if (translated) name = translated[1].trim().replace(/^["']|["']$/g, '');
  }
  return name || null;
}

// Jogos da conta Ubisoft, tirados do cache que o Ubisoft Connect mantém em disco
// (cache/configuration/configurations): uma lista protobuf de produtos, cada um
// com id e uma configuração em YAML.
function readUbisoftLibrary(launcherDir) {
  const games = [];
  let buf;
  try {
    buf = fs.readFileSync(path.join(launcherDir, 'cache', 'configuration', 'configurations'));
  } catch {
    return games;
  }
  eachField(buf, (field, product) => {
    if (field !== 1 || !Buffer.isBuffer(product)) return;
    let id = null;
    let yaml = '';
    eachField(product, (number, value) => {
      if (number === 1 && typeof value === 'number') id = value;
      if (number === 3 && Buffer.isBuffer(value)) yaml = value.toString('utf8');
    });
    // Só o que pode ser iniciado é jogo; "is_ulc" marca conteúdo adicional.
    if (!id || !/^ +start_game:/m.test(yaml) || /^ +is_ulc: *(yes|true)/m.test(yaml)) return;
    const name = ubisoftName(yaml);
    if (name) games.push({ id: String(id), name });
  });
  return games;
}

// Ubisoft Connect: o registro dá a pasta do launcher e as instalações; os nomes
// e os jogos não instalados vêm do cache do launcher.
async function scanUbisoft() {
  const tree = await regTree('HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher');
  if (!tree.size) return [];
  const launcher = [...tree].find(([key]) => /\\Launcher$/i.test(key));
  const launcherDir = launcher && launcher[1].InstallDir;
  const library = launcherDir ? readUbisoftLibrary(path.normalize(launcherDir)) : [];
  const names = new Map(library.map((game) => [game.id, game.name]));

  const games = new Map();
  for (const [key, values] of tree) {
    const id = lastPart(key);
    const folder = values.InstallDir && path.normalize(values.InstallDir);
    if (!/\\Installs\\\d+$/i.test(key) || !folder || !isDir(folder)) continue;
    games.set(id, {
      id: 'ubisoft:' + id,
      name: names.get(id) || path.basename(folder),
      source: 'Ubisoft',
      ready: true,
      folder,
      launch: { type: 'url', target: 'uplay://launch/' + id + '/0' },
      // O Ubisoft Connect abre a própria confirmação.
      uninstall: { type: 'url', target: 'uplay://uninstall/' + id },
    });
  }
  // O que está na conta mas não instalado: abrir leva ao Ubisoft Connect.
  for (const game of library) {
    if (games.has(game.id)) continue;
    games.set(game.id, {
      id: 'ubisoft:' + game.id,
      name: game.name,
      source: 'Ubisoft',
      installed: false,
      ready: true,
      launch: { type: 'url', target: 'uplay://launch/' + game.id + '/0' },
    });
  }
  return [...games.values()];
}

// EA App: os jogos aparecem na lista de desinstalação apontando para o
// EAInstaller; o executável está descrito no installerdata.xml de cada jogo.
async function scanEa() {
  const commonFiles = process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files';
  if (!isDir(path.join(commonFiles, 'EAInstaller'))) return [];

  const games = new Map();
  for (const root of UNINSTALL) {
    for (const [key, values] of await regTree(root)) {
      const folder = values.InstallLocation && path.normalize(values.InstallLocation);
      if (!/EAInstaller/i.test(values.UninstallString || '') || !values.DisplayName || !folder) continue;
      let exe = null;
      try {
        const xml = fs.readFileSync(path.join(folder, '__Installer', 'installerdata.xml'), 'utf8');
        // <filePath>[HKEY_...\Install Dir]Jogo.exe</filePath>: o que vem depois do ] é relativo à pasta.
        const m = xml.match(/<filePath>\[[^\]]*\]([^<]+\.exe)<\/filePath>/i);
        if (m) exe = path.join(folder, m[1]);
      } catch {
        // Sem installerdata.xml: não dá para saber o executável.
      }
      if (!exe || !fs.existsSync(exe)) continue;
      games.set(folder.toLowerCase(), {
        id: `ea:${lastPart(key)}`,
        name: values.DisplayName,
        source: 'EA',
        ready: true,
        exe,
        folder,
        launch: { type: 'exe', target: exe },
        // O mesmo comando que o Windows usa em "Aplicativos instalados".
        uninstall: { type: 'command', target: values.UninstallString },
      });
    }
  }
  return [...games.values()];
}

// Tudo o que o Windows lista em "Aplicativos instalados" e tem desinstalador:
// [{ name, location, command }]. É onde instaladores (inclusive os de repacks)
// registram como remover o que instalaram.
async function registeredUninstallers() {
  const list = [];
  for (const root of [...UNINSTALL, 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
    for (const values of (await regTree(root)).values()) {
      if (!values.UninstallString || !values.DisplayName) continue;
      const location = values.InstallLocation
        ? path.normalize(values.InstallLocation.replace(/^"|"$/g, '')).replace(/[\\/]+$/, '')
        : null;
      list.push({ name: values.DisplayName, location, command: values.UninstallString });
    }
  }
  return list;
}

module.exports = { scanGog, scanUbisoft, scanEa, parseReg, readUbisoftLibrary, registeredUninstallers };

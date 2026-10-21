// Backup dos saves dos jogos. Onde cada jogo guarda os saves vem do catálogo
// público do Ludusavi (github.com/mtkennerly/ludusavi-manifest), baixado uma vez
// e atualizado por semana; para jogos fora do catálogo, vale a pasta escolhida à mão.
// Cada backup é uma pasta com a data, com uma cópia dos arquivos e um backup.json
// dizendo de onde cada um veio (é o que permite restaurar).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
const MANIFEST_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const KEEP = 5; // backups guardados por jogo

const simple = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const safeName = (name) => String(name || 'jogo').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120) || 'jogo';

// Chave de YAML, com ou sem aspas.
function yamlKey(text) {
  text = text.trim();
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

// Separa "chave: valor" no fim de uma linha de YAML, respeitando aspas na chave.
function splitKey(line) {
  const text = line.trim();
  let end = -1;
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    for (let i = 1; i < text.length; i++) {
      if (text[i] === '\\' && quote === '"') i++;
      else if (text[i] === quote && (quote !== "'" || text[i + 1] !== "'")) {
        end = text.indexOf(':', i);
        break;
      } else if (text[i] === quote) i++;
    }
  } else {
    end = text.indexOf(':');
  }
  if (end < 0) return null;
  return { key: yamlKey(text.slice(0, end)), value: text.slice(end + 1).trim() };
}

class Saves {
  // options: { manifestFile, root(): pasta dos backups }
  constructor(options) {
    this.options = options;
    this.index = null; // títulos e ids -> posição no catálogo, montado sob demanda
    this.text = null;
    this.downloading = null;
  }

  // Baixa o catálogo se não houver cópia ou se ela tiver mais de uma semana.
  async manifest() {
    const file = this.options.manifestFile;
    let fresh = false;
    try {
      fresh = Date.now() - fs.statSync(file).mtimeMs < MANIFEST_MAX_AGE;
    } catch {
      // Ainda não baixado.
    }
    if (!fresh) {
      this.downloading ??= (async () => {
        try {
          const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(60000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = Buffer.from(await res.arrayBuffer());
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file + '.tmp', body);
          fs.renameSync(file + '.tmp', file);
          this.index = null;
          this.text = null;
        } catch (err) {
          // Sem internet: segue com a cópia antiga, se houver.
          if (!fs.existsSync(file)) throw new Error('Não deu para baixar o catálogo de saves. Confira a internet.');
        } finally {
          this.downloading = null;
        }
      })();
      await this.downloading;
    }
    if (!this.index) this.buildIndex(fs.readFileSync(file, 'utf8'));
    // O texto (17 MB) só fica na memória enquanto é usado.
    clearTimeout(this.release);
    this.release = setTimeout(() => {
      this.text = null;
      this.index = null;
    }, 60000);
  }

  // Uma passada pelo catálogo: onde começa cada jogo, e por que nome e ids achá-lo.
  buildIndex(text) {
    this.text = text;
    const index = { title: new Map(), steam: new Map(), gog: new Map() };
    let start = 0;
    let current = null;
    let section = null;
    let pos = 0;
    while (pos < text.length) {
      const next = text.indexOf('\n', pos);
      const end = next < 0 ? text.length : next;
      const line = text.slice(pos, end).replace(/\r$/, '');
      if (line && line[0] !== ' ' && line[0] !== '#' && !line.startsWith('---')) {
        const parsed = splitKey(line);
        if (parsed) {
          start = pos;
          current = { title: parsed.key, start };
          index.title.set(simple(parsed.key), current);
          section = null;
        }
      } else if (current && /^ {2}\S/.test(line)) {
        section = line.trim().replace(/:$/, '');
      } else if (current && /^ {4}id: *\d+$/.test(line) && (section === 'steam' || section === 'gog')) {
        index[section].set(line.split(':')[1].trim(), current);
      }
      pos = end + 1;
    }
    this.index = index;
  }

  // Lê, do catálogo, as pastas e arquivos de save de um jogo (só Windows e só saves).
  entryFiles(entry, store) {
    const text = this.text;
    const files = [];
    let pos = text.indexOf('\n', entry.start) + 1;
    let section = null;
    let current = null;
    let sub = null;
    let when = null;
    while (pos < text.length) {
      const next = text.indexOf('\n', pos);
      const end = next < 0 ? text.length : next;
      const line = text.slice(pos, end).replace(/\r$/, '');
      pos = end + 1;
      if (!line.trim()) continue;
      if (line[0] !== ' ') break; // começou o próximo jogo
      const indent = line.length - line.trimStart().length;
      if (indent === 2) {
        section = line.trim().replace(/:.*$/, '');
        continue;
      }
      if (section !== 'files') continue;
      if (indent === 4) {
        const parsed = splitKey(line);
        current = parsed ? { path: parsed.key, tags: [], when: [] } : null;
        if (current) files.push(current);
        sub = null;
      } else if (current && indent === 6) {
        sub = line.trim().replace(/:.*$/, '');
      } else if (current && indent === 8 && line.trim().startsWith('- ')) {
        const item = line.trim().slice(2);
        if (sub === 'tags') current.tags.push(item);
        if (sub === 'when') {
          when = {};
          current.when.push(when);
          const parsed = splitKey(item);
          if (parsed) when[parsed.key] = parsed.value;
        }
      } else if (current && indent === 10 && sub === 'when' && when) {
        const parsed = splitKey(line);
        if (parsed) when[parsed.key] = parsed.value;
      }
    }
    return files
      .filter((file) => !file.tags.length || file.tags.includes('save'))
      .filter((file) => !file.when.length || file.when.some((w) => (!w.os || w.os === 'windows') && (!w.store || !store || w.store === store)))
      .map((file) => file.path);
  }

  // Troca os marcadores do catálogo (<home>, <winAppData>...) pelos caminhos desta
  // máquina. Devolve null quando o caminho depende de algo que não se sabe.
  resolvePlaceholders(pattern, game) {
    const env = process.env;
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const values = {
      '<home>': os.homedir(),
      '<winAppData>': env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      '<winLocalAppData>': local,
      '<winLocalAppDataLow>': path.join(path.dirname(local), 'LocalLow'),
      '<winDocuments>': this.options.documents || path.join(os.homedir(), 'Documents'),
      '<winPublic>': env.PUBLIC || 'C:\\Users\\Public',
      '<winProgramData>': env.ProgramData || 'C:\\ProgramData',
      '<winDir>': env.WINDIR || 'C:\\Windows',
      '<osUserName>': os.userInfo().username,
      '<storeUserId>': '*',
      '<storeGameId>': game.appid || '*',
      '<base>': game.folder || null,
      '<game>': game.folder ? path.basename(game.folder) : null,
      '<root>': game.storeRoot || null,
    };
    let result = pattern;
    for (const marker of pattern.match(/<[a-zA-Z]+>/g) || []) {
      if (!(marker in values) || values[marker] === null) return null;
      result = result.split(marker).join(values[marker].replace(/\\/g, '/'));
    }
    return result;
  }

  // Expande curingas (*, ?, **) num caminho e devolve só o que existe.
  expand(pattern) {
    const parts = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || !/^[a-zA-Z]:$/.test(parts[0])) return [];
    let found = [parts[0] + '\\'];
    const toRegex = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    for (const part of parts.slice(1)) {
      const next = [];
      for (const base of found) {
        if (part === '**') {
          // Qualquer profundidade (limitada, para não varrer o disco).
          const stack = [[base, 0]];
          while (stack.length && next.length < 500) {
            const [dir, depth] = stack.pop();
            next.push(dir);
            if (depth >= 6) continue;
            try {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) stack.push([path.join(dir, entry.name), depth + 1]);
            } catch {
              // Pasta sem acesso.
            }
          }
        } else if (/[*?]/.test(part)) {
          const regex = toRegex(part);
          try {
            for (const name of fs.readdirSync(base)) if (regex.test(name)) next.push(path.join(base, name));
          } catch {
            // Pasta sem acesso.
          }
        } else {
          const candidate = path.join(base, part);
          if (fs.existsSync(candidate)) next.push(candidate);
        }
      }
      found = [...new Set(next)].slice(0, 500);
      if (!found.length) break;
    }
    return found;
  }

  // Onde estão os saves de um jogo nesta máquina.
  // game: { id, name, appid, gogId, store, folder, storeRoot, custom: [pastas escolhidas à mão] }
  async locate(game) {
    if (game.custom && game.custom.length) {
      return { from: 'manual', paths: game.custom.filter((dir) => fs.existsSync(dir)) };
    }
    await this.manifest();
    const { index } = this;
    const entry = (game.appid && index.steam.get(String(game.appid)))
      || (game.gogId && index.gog.get(String(game.gogId)))
      || index.title.get(simple(game.name));
    if (!entry) return { from: null, paths: [] };
    const paths = new Set();
    for (const pattern of this.entryFiles(entry, game.store)) {
      const resolved = this.resolvePlaceholders(pattern, game);
      if (resolved) for (const found of this.expand(resolved)) paths.add(found);
    }
    // Uma pasta que está dentro de outra já incluída não precisa entrar de novo.
    const list = [...paths].sort((a, b) => a.length - b.length);
    const top = list.filter((p, i) => !list.slice(0, i).some((parent) => p.toLowerCase().startsWith(parent.toLowerCase() + path.sep)));
    return { from: 'catálogo', title: entry.title, paths: top };
  }

  gameFolder(game) {
    return path.join(this.options.root(), safeName(game.name));
  }

  // Backups do jogo, do mais novo para o mais antigo.
  list(game) {
    const folder = this.gameFolder(game);
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      return [];
    }
    return names
      .map((name) => {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(folder, name, 'backup.json'), 'utf8'));
          return { dir: path.join(folder, name), ...info };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
  }

  // Resumo do que existe agora: muda quando qualquer arquivo de save muda.
  async signature(paths) {
    let count = 0;
    let bytes = 0;
    let newest = 0;
    const visit = async (target) => {
      let stat;
      try {
        stat = await fs.promises.stat(target);
      } catch {
        return;
      }
      if (stat.isDirectory()) {
        let entries = [];
        try {
          entries = await fs.promises.readdir(target);
        } catch {
          return;
        }
        for (const name of entries) await visit(path.join(target, name));
      } else {
        count++;
        bytes += stat.size;
        newest = Math.max(newest, stat.mtimeMs);
      }
    };
    for (const target of paths) await visit(target);
    return { key: `${count}:${bytes}:${Math.round(newest)}`, count, bytes };
  }

  // Copia os saves para uma pasta nova com a data. Não faz nada se nada mudou desde o último backup.
  // keepAll: não apaga os mais antigos agora (a restauração ainda vai ler um deles).
  async backup(game, reason, keepAll) {
    const located = await this.locate(game);
    if (!located.paths.length) {
      return { ok: false, notFound: true, error: located.from ? 'Os saves deste jogo ainda não existem neste computador.' : 'Este jogo não está no catálogo de saves. Escolha a pasta dos saves dele.' };
    }
    const signature = await this.signature(located.paths);
    const last = this.list(game)[0];
    if (last && last.signature === signature.key) return { ok: true, unchanged: true, at: last.at };

    const at = Date.now();
    const stamp = new Date(at).toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dir = path.join(this.gameFolder(game), stamp);
    fs.mkdirSync(dir, { recursive: true });
    const items = [];
    for (const [i, source] of located.paths.entries()) {
      const stored = `${i + 1}-${safeName(path.basename(source))}`;
      await fs.promises.cp(source, path.join(dir, stored), { recursive: true, force: true, errorOnExist: false });
      items.push({ source, stored });
    }
    fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify({ game: game.name, id: game.id, at, reason, signature: signature.key, files: signature.count, bytes: signature.bytes, items }, null, 2));

    if (!keepAll) this.trim(game);
    return { ok: true, at, files: signature.count, bytes: signature.bytes, dir };
  }

  // Guarda só os últimos.
  trim(game) {
    for (const old of this.list(game).slice(KEEP)) fs.rmSync(old.dir, { recursive: true, force: true });
  }

  // Devolve um backup aos lugares de origem. Antes, guarda o estado atual (dá para desfazer).
  async restore(game, dir) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8'));
    await this.backup(game, 'antes de restaurar', true);
    for (const item of info.items) {
      fs.mkdirSync(path.dirname(item.source), { recursive: true });
      await fs.promises.cp(path.join(dir, item.stored), item.source, { recursive: true, force: true, errorOnExist: false });
    }
    this.trim(game);
    return { ok: true, files: info.files };
  }
}

module.exports = { Saves };

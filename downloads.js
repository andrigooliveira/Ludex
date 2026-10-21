// Gerenciador de downloads: magnet e .torrent (WebTorrent), URL direta (HTTP)
// e os três via Real-Debrid quando o usuário tem token. O conteúdo é o que o
// usuário trouxer; aqui não há catálogo nem busca (as fontes ficam em sources.js).
const fs = require('fs');
const path = require('path');
const { EventEmitter, once } = require('events');
const { pathToFileURL } = require('url');
const realDebrid = require('./realdebrid');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Nome seguro para arquivo ou pasta no Windows.
function safeName(name) {
  const clean = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return clean.slice(0, 180) || 'download';
}

function nameFromUrl(url) {
  try {
    return safeName(decodeURIComponent(path.basename(new URL(url).pathname)));
  } catch {
    return 'download';
  }
}

function nameFromHeaders(res) {
  const header = res.headers.get('content-disposition') || '';
  const encoded = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  const plain = header.match(/filename="?([^";]+)"?/i);
  try {
    if (encoded) return safeName(decodeURIComponent(encoded[1].trim()));
  } catch {
    // Cabeçalho malformado: usa o nome simples.
  }
  return plain ? safeName(plain[1]) : null;
}

const HISTORY = 120; // amostras guardadas, uma por segundo

const RD_STATUS = {
  magnet_conversion: 'convertendo o magnet',
  waiting_files_selection: 'escolhendo os arquivos',
  queued: 'na fila',
  downloading: 'baixando nos servidores',
  compressing: 'compactando',
  uploading: 'enviando',
  downloaded: 'pronto',
};

class Downloads extends EventEmitter {
  // options: { file, torrentsDir, defaultDir(), rdToken() }
  constructor(options) {
    super();
    this.options = options;
    this.items = [];
    try {
      this.items = JSON.parse(fs.readFileSync(options.file, 'utf8'));
    } catch {
      // Primeira execução.
    }
    // O que estava em andamento quando o app fechou volta pausado e é retomado por resumeInterrupted().
    this.interrupted = this.items.filter((item) => ['preparing', 'choosing', 'downloading'].includes(item.status)).map((item) => item.id);
    for (const item of this.items) {
      // Torrent começado antes de existir a escolha de arquivos: segue baixando tudo.
      if (item.wanted === undefined && !item.fileList && item.total > 0 && item.mode === 'torrent') item.wanted = 'all';
      if (this.interrupted.includes(item.id)) item.status = 'paused';
      item.speed = 0;
      item.peers = 0;
    }
    this.active = new Map(); // id -> { stop(): Promise } do que está rodando
    this.lastBytes = new Map();
    this.ticks = 0;
    // Histórico de velocidade dos últimos 2 minutos: geral e por download.
    this.global = [];
    this.series = new Map();
    this.wasBusy = false;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  list() {
    return this.items.map(({ source, files, rdId, fileList, wanted, ...visible }) => ({
      ...visible,
      kind: source.type,
      canChoose: this.canChoose({ fileList, status: visible.status }),
    }));
  }

  // ---------- Escolha dos arquivos do torrent ----------
  // item.fileList: os arquivos do torrent ({ name, size }), conhecidos quando chegam os metadados.
  // item.wanted:   índices dos que serão baixados; sem ele, o download espera a escolha ('choosing').

  // Só no torrent direto (pelo Real-Debrid vai tudo) e enquanto não terminou.
  canChoose(item) {
    return Boolean(item.fileList && item.fileList.length > 1 && item.status !== 'done');
  }

  // Chamado quando a lista de arquivos fica conhecida. Com um arquivo só não há o que escolher.
  setFileList(item, fileList) {
    item.fileList = fileList;
    if (item.wanted === 'all' || fileList.length === 1) item.wanted = fileList.map((_, index) => index);
  }

  fileList(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || !item.fileList) return null;
    return {
      name: item.name,
      canChoose: this.canChoose(item),
      files: item.fileList.map((file, index) => ({ name: file.name, size: file.size, wanted: !Array.isArray(item.wanted) || item.wanted.includes(index) })),
    };
  }

  // Pausa o download no estado "escolher arquivos" até selectFiles() ou uma pausa.
  waitChoice(item, control) {
    item.status = 'choosing';
    this.changed();
    this.emit('choose', item);
    return new Promise((resolve) => {
      control.choose = resolve;
      control.abort.signal.addEventListener('abort', resolve, { once: true });
    });
  }

  selectFiles(id, indexes) {
    const item = this.items.find((i) => i.id === id);
    if (!item || !this.canChoose(item)) return false;
    const wanted = [...new Set(indexes)].filter((index) => Number.isInteger(index) && item.fileList[index]).sort((a, b) => a - b);
    if (!wanted.length) return false;
    item.wanted = wanted;
    const control = this.active.get(id);
    if (control && control.choose) {
      control.choose();
      control.choose = null;
    } else if (control && control.torrent) {
      // Já baixando: troca a seleção com o torrent andando.
      this.applySelection(item, control.torrent);
      control.checkDone();
    }
    this.changed();
    return true;
  }

  // Os arquivos não escolhidos ganham no disco um pedaço que divide bloco com um
  // vizinho escolhido (e ficam com o tamanho cheio reservado). Com o download
  // terminado eles não servem mais: sai o arquivo e as pastas que ficarem vazias.
  removeLeftovers(dir, files) {
    const root = path.resolve(dir);
    for (const file of files) {
      const full = path.resolve(root, file);
      if (!full.startsWith(root + path.sep)) continue;
      try {
        fs.rmSync(full, { force: true });
        for (let folder = path.dirname(full); folder !== root; folder = path.dirname(folder)) fs.rmdirSync(folder);
      } catch {
        // Pasta ainda com arquivos (ou arquivo em uso): fica como está.
      }
    }
  }

  applySelection(item, torrent) {
    torrent.files.forEach((file, index) => {
      file.deselect();
      if (item.wanted.includes(index)) file.select();
    });
    item.total = item.wanted.reduce((sum, index) => sum + torrent.files[index].length, 0);
  }

  history() {
    return { global: this.global, items: Object.fromEntries(this.series) };
  }

  changed() {
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      fs.writeFileSync(this.options.file, JSON.stringify(this.items, null, 2));
    } catch {
      // Sem conseguir gravar, o estado vale só até fechar.
    }
    this.emit('update', this.list(), this.history());
  }

  // Uma vez por segundo: atualiza progresso e velocidade do que está baixando.
  tick() {
    const now = Date.now();
    const keep = (samples, sample) => {
      samples.push(sample);
      if (samples.length > HISTORY) samples.shift();
    };
    let down = 0;
    let up = 0;
    for (const [id, running] of this.active) {
      const item = this.items.find((i) => i.id === id);
      if (!item) continue;
      if (running.torrent && running.torrent.length) {
        const torrent = running.torrent;
        // Só conta o que foi escolhido para baixar.
        const wanted = Array.isArray(item.wanted) ? item.wanted : [];
        item.received = wanted.reduce((sum, index) => sum + torrent.files[index].downloaded, 0);
        item.speed = Math.round(torrent.downloadSpeed);
        item.upSpeed = Math.round(torrent.uploadSpeed);
        item.uploaded = torrent.uploaded;
        item.peers = torrent.numPeers;
        item.contents = torrent.files.slice(0, 300).map((f, index) => ({ name: f.path, size: f.length, progress: f.progress, wanted: wanted.includes(index) }));
      } else {
        item.speed = Math.max(0, item.received - (this.lastBytes.get(id) ?? item.received));
        this.lastBytes.set(id, item.received);
      }
      down += item.speed;
      up += item.upSpeed || 0;
      if (!this.series.has(id)) this.series.set(id, []);
      keep(this.series.get(id), { t: now, down: item.speed, up: item.upSpeed || 0 });
    }
    keep(this.global, { t: now, down, up });

    // Parado, não há o que avisar (só mais uma vez, para a tela ver a velocidade zerar).
    const busy = this.active.size > 0;
    if (!busy && !this.wasBusy) return;
    this.wasBusy = busy;
    // Grava o progresso a cada 10 s, para reabrir o app já mostrando onde parou.
    if (busy && ++this.ticks % 10 === 0) this.changed();
    else this.emit('update', this.list(), this.history());
  }

  // input: { magnet } | { url } | { torrentFile }, mais { useRd, dir, name }
  add(input) {
    const id = `dl:${Date.now()}`;
    const item = {
      id,
      name: 'Preparando...',
      mode: input.useRd && this.options.rdToken() ? 'rd' : null,
      source: null,
      dir: input.dir || this.options.defaultDir(),
      path: null,
      status: 'paused',
      note: null,
      total: 0,
      received: 0,
      speed: 0,
      upSpeed: 0,
      uploaded: 0,
      peers: 0,
      error: null,
      addedAt: Date.now(),
    };

    if (input.torrentFile) {
      // Guarda uma cópia do .torrent para poder retomar depois.
      fs.mkdirSync(this.options.torrentsDir, { recursive: true });
      const copy = path.join(this.options.torrentsDir, `${Date.now()}.torrent`);
      fs.copyFileSync(input.torrentFile, copy);
      item.source = { type: 'torrent', file: copy };
      item.name = path.parse(input.torrentFile).name;
    } else if (/^magnet:\?/i.test(input.magnet || '')) {
      item.source = { type: 'magnet', value: input.magnet.trim() };
      const dn = new URLSearchParams(input.magnet.slice(input.magnet.indexOf('?') + 1)).get('dn');
      if (dn) item.name = dn;
    } else if (/^https?:\/\//i.test(input.url || '')) {
      item.source = { type: 'url', value: input.url.trim() };
      item.name = nameFromUrl(input.url);
    } else {
      throw new Error('Cole um link magnet ou uma URL http(s), ou abra um arquivo .torrent.');
    }
    item.mode ??= item.source.type === 'url' ? 'http' : 'torrent';
    // Nome vindo de uma fonte: vale até o download dizer o nome real.
    if (input.name) item.name = String(input.name).slice(0, 180);

    this.items.unshift(item);
    this.resume(id);
    return id;
  }

  resumeInterrupted() {
    for (const id of this.interrupted.splice(0)) this.resume(id);
  }

  resume(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || this.active.has(id) || item.status === 'done') return;
    item.status = 'preparing';
    item.error = null;
    item.note = null;
    this.lastBytes.delete(id);
    const control = { stopped: false, abort: new AbortController(), torrent: null };
    control.stop = async () => {
      control.stopped = true;
      control.abort.abort();
      if (control.torrent) await new Promise((resolve) => control.torrent.destroy({ destroyStore: false }, resolve));
    };
    this.active.set(id, control);
    this.changed();

    const run = { torrent: () => this.runTorrent(item, control), http: () => this.runHttp(item, control), rd: () => this.runRealDebrid(item, control) }[item.mode];
    run().then(() => {
      if (control.stopped) return;
      item.status = 'done';
      item.received = item.total || item.received;
      this.emit('done', item);
    }).catch((err) => {
      if (control.stopped) return;
      item.status = 'error';
      item.error = err.message || String(err);
    }).finally(() => {
      if (this.active.get(id) === control) this.active.delete(id);
      item.speed = 0;
      item.upSpeed = 0;
      item.peers = 0;
      item.note = null;
      this.changed();
    });
  }

  async pause(id) {
    const item = this.items.find((i) => i.id === id);
    const control = this.active.get(id);
    if (!item || !control) return;
    await control.stop();
    this.active.delete(id);
    item.status = 'paused';
    item.speed = 0;
    item.upSpeed = 0;
    item.peers = 0;
    this.changed();
  }

  // Tira da lista. Os arquivos já baixados ficam no disco.
  async remove(id) {
    const control = this.active.get(id);
    if (control) await control.stop();
    this.active.delete(id);
    const item = this.items.find((i) => i.id === id);
    if (item && item.source.file) fs.rmSync(item.source.file, { force: true });
    this.items = this.items.filter((i) => i.id !== id);
    this.series.delete(id);
    this.changed();
  }

  async destroy() {
    clearInterval(this.timer);
    this.tick();
    for (const control of this.active.values()) {
      control.stopped = true;
      control.abort.abort();
    }
    this.changed(); // o que estava baixando fica gravado assim e é retomado na próxima abertura
    if (this.clientPromise) {
      const client = await this.clientPromise;
      await new Promise((resolve) => client.destroy(resolve));
    }
  }

  // ---------- Torrent ----------

  // O WebTorrent é um módulo ES: carrega sob demanda, só quando há torrent.
  client() {
    this.clientPromise ??= import(pathToFileURL(require.resolve('webtorrent')).href).then((mod) => {
      // Sem uTP: o módulo nativo dele derruba o processo ao fechar o app. TCP e web seeds bastam.
      const client = new mod.default({ utp: false });
      client.on('error', () => {}); // erros de cada torrent são tratados no próprio torrent
      return client;
    });
    return this.clientPromise;
  }

  async runTorrent(item, control) {
    const client = await this.client();
    if (control.stopped) return;
    const input = item.source.file ? fs.readFileSync(item.source.file) : item.source.value;
    fs.mkdirSync(item.dir, { recursive: true });

    await new Promise((resolve, reject) => {
      let torrent;
      try {
        // Começa sem nada selecionado: só baixa o que for escolhido.
        // Sem a cópia em memória dos últimos blocos gravados: o Windows já faz esse cache, e em torrent de bloco grande ela passa de 100 MB.
        torrent = client.add(input, { path: item.dir, deselect: true, storeCacheSlots: 0 });
      } catch (err) {
        reject(err);
        return;
      }
      control.torrent = torrent;
      const onClientError = (err) => {
        // Erros de inclusão (ex.: torrent duplicado) chegam pelo cliente.
        if (!torrent.ready || /duplicate/i.test(String(err))) reject(new Error(/duplicate/i.test(String(err)) ? 'Este torrent já está na lista.' : String(err.message || err)));
      };
      client.once('error', onClientError);
      const cleanup = () => client.removeListener('error', onClientError);
      // O torrent só avisa 'done' com todos os arquivos; aqui termina quando os escolhidos estiverem completos.
      let finished = false;
      const checkDone = () => {
        if (finished || control.stopped || !Array.isArray(item.wanted) || !torrent.ready) return;
        if (!item.wanted.every((index) => torrent.files[index].done)) return;
        finished = true;
        cleanup();
        item.received = item.total;
        control.torrent = null; // o tick não deve mais ler um torrent que está sendo encerrado
        // Terminou: para de semear e libera o cliente. Fora do evento, porque o
        // WebTorrent ainda está no meio da conferência quando avisa que o arquivo acabou.
        const leftovers = torrent.files.filter((file, index) => !item.wanted.includes(index) && !file.done).map((file) => file.path);
        setImmediate(() => torrent.destroy({ destroyStore: false }, () => {
          this.removeLeftovers(item.dir, leftovers);
          resolve();
        }));
      };
      control.checkDone = checkDone;
      torrent.on('metadata', async () => {
        item.name = torrent.name;
        item.total = torrent.length;
        item.path = path.join(item.dir, torrent.name);
        this.setFileList(item, torrent.files.map((file) => ({ name: file.path, size: file.length })));
        for (const file of torrent.files) file.on('done', checkDone);
        // Com o .torrent guardado, retomar não depende de achar os metadados de novo.
        if (!item.source.file && torrent.torrentFile) {
          try {
            fs.mkdirSync(this.options.torrentsDir, { recursive: true });
            item.source.file = path.join(this.options.torrentsDir, `${torrent.infoHash}.torrent`);
            fs.writeFileSync(item.source.file, torrent.torrentFile);
          } catch {
            item.source.file = undefined;
          }
        }
        if (!Array.isArray(item.wanted)) await this.waitChoice(item, control);
        if (control.stopped) return;
        this.applySelection(item, torrent);
        item.status = 'downloading';
        this.changed();
        checkDone();
      });
      torrent.on('error', (err) => { cleanup(); reject(err); });
      // 'ready' vem depois de conferir o que já estava no disco.
      torrent.on('ready', checkDone);
      torrent.on('close', cleanup);
    });
  }

  // ---------- HTTP ----------

  // Baixa item.files em sequência, retomando o que já estiver parcial no disco.
  async runHttp(item, control) {
    item.files ??= [{ url: item.source.value, name: null, size: 0 }];
    const single = item.files.length === 1;
    const folder = single ? item.dir : path.join(item.dir, safeName(item.name));
    fs.mkdirSync(folder, { recursive: true });
    item.status = 'downloading';
    this.changed();

    let before = 0; // bytes dos arquivos já concluídos
    for (const file of item.files) {
      if (control.stopped) return;
      if (!file.done) await this.downloadFile(item, file, folder, before, control);
      before += file.size;
    }
    item.total = before;
    item.path = single ? path.join(folder, item.files[0].name) : folder;
  }

  async downloadFile(item, file, folder, before, control) {
    // Enquanto baixa, o arquivo tem sufixo .part; o tamanho dele diz de onde retomar.
    const known = file.name ? path.join(folder, `${file.name}.part`) : null;
    let start = known && fs.existsSync(known) ? fs.statSync(known).size : 0;
    const res = await fetch(file.url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal: control.abort.signal });
    if (!res.ok && res.status !== 416) throw new Error(`O servidor respondeu HTTP ${res.status}. Se o link expirou, adicione o download de novo.`);

    file.name ??= nameFromHeaders(res) || nameFromUrl(file.url);
    if (item.files.length === 1) {
      item.name = file.name;
      item.path = path.join(folder, file.name);
    }
    const part = path.join(folder, `${file.name}.part`);
    const final = path.join(folder, file.name);

    if (res.status !== 416) {
      const partial = res.status === 206;
      if (!partial) start = 0; // servidor não aceita retomar: recomeça
      file.size = start + (Number(res.headers.get('content-length')) || 0);
      item.total = Math.max(item.total, before + file.size);
      item.received = before + start;
      const out = fs.createWriteStream(part, { flags: partial ? 'a' : 'w' });
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await once(out, 'drain');
          item.received += chunk.length;
        }
      } finally {
        await new Promise((resolve) => out.end(resolve));
      }
      if (control.stopped) return;
      // Sem content-length, o tamanho real é o que chegou.
      file.size = fs.statSync(part).size;
    } else {
      file.size = start; // 416: o .part já estava completo
    }
    fs.renameSync(part, final);
    file.done = true;
    item.received = before + file.size;
  }

  // ---------- Real-Debrid ----------

  async runRealDebrid(item, control) {
    const token = this.options.rdToken();
    if (!token) throw new Error('Configure o token do Real-Debrid ou adicione o download sem ele.');

    if (!item.files) {
      if (item.source.type === 'url') {
        const link = await realDebrid.unrestrict(token, item.source.value);
        item.name = safeName(link.filename);
        item.files = [{ url: link.download, name: safeName(link.filename), size: link.filesize || 0 }];
      } else {
        item.rdId ??= item.source.type === 'magnet'
          ? await realDebrid.addMagnet(token, item.source.value)
          : await realDebrid.addTorrent(token, fs.readFileSync(item.source.file));

        // O Real-Debrid baixa o torrent nos servidores dele; aqui só se acompanha.
        let info;
        for (;;) {
          if (control.stopped) return;
          info = await realDebrid.info(token, item.rdId);
          if (info.filename) item.name = safeName(info.filename);
          if (info.status === 'waiting_files_selection') await realDebrid.selectAllFiles(token, item.rdId);
          if (info.status === 'downloaded') break;
          if (!RD_STATUS[info.status]) throw new Error(`O Real-Debrid não conseguiu este torrent (${info.status}).`);
          item.note = `Real-Debrid: ${RD_STATUS[info.status]}${info.progress ? ` · ${info.progress}%` : ''}`;
          this.emit('update', this.list(), this.history());
          await sleep(3000);
        }
        item.files = [];
        for (const hosted of info.links || []) {
          const link = await realDebrid.unrestrict(token, hosted);
          item.files.push({ url: link.download, name: safeName(link.filename), size: link.filesize || 0 });
        }
        if (!item.files.length) throw new Error('O Real-Debrid não devolveu nenhum arquivo para este torrent.');
      }
      item.total = item.files.reduce((sum, file) => sum + file.size, 0);
      item.note = null;
    }
    if (control.stopped) return;
    await this.runHttp(item, control);
  }
}

module.exports = { Downloads, safeName };

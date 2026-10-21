// Fontes de download: catálogos em .json (títulos com os seus links), lidos de
// uma URL ou de um arquivo local. O formato é o mesmo das fontes do Hydra:
//   { "name": "...", "downloads": [{ "title", "uris": ["magnet:...", "https://..."], "uploadDate", "fileSize" }] }
// Os itens lidos ficam copiados na pasta de dados do launcher: a fonte continua
// valendo se o arquivo original for apagado ou o servidor sair do ar.
// Aqui só se guarda e se busca; quem baixa é o gerenciador de downloads.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_AGE = 60 * 60 * 1000;
const SUPPORTED = /^(magnet:\?|https?:\/\/)/i;

// Sem acentos e em minúsculas, para a busca.
const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function formatSize(size) {
  if (typeof size === 'string') return size.trim().slice(0, 20) || null;
  if (!Number.isFinite(size) || size <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** power).toLocaleString('pt-BR', { maximumFractionDigits: power > 1 ? 1 : 0 })} ${units[power]}`;
}

// Valida o .json e fica só com o que o launcher usa. Itens sem título ou sem
// link magnet/http(s) são descartados.
function parse(data) {
  if (!data || !Array.isArray(data.downloads)) throw new Error('Este .json não é uma fonte: falta a lista "downloads".');
  const entries = [];
  for (const raw of data.downloads) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').trim().slice(0, 200);
    const uris = (Array.isArray(raw.uris) ? raw.uris : [raw.uri])
      .filter((uri) => typeof uri === 'string' && SUPPORTED.test(uri.trim()))
      .map((uri) => uri.trim());
    if (!title || !uris.length) continue;
    entries.push({ title, uris, size: formatSize(raw.fileSize), date: Date.parse(raw.uploadDate) || null });
  }
  if (!entries.length) throw new Error('A fonte não tem nenhum item com link magnet ou http(s).');
  return { name: String(data.name || '').trim().slice(0, 60), entries };
}

async function read(source) {
  let text;
  if (source.url) {
    const res = await fetch(source.url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`O servidor respondeu HTTP ${res.status}.`);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('A fonte é grande demais (mais de 64 MB).');
    text = await res.text();
  } else {
    if (fs.statSync(source.file).size > MAX_BYTES) throw new Error('A fonte é grande demais (mais de 64 MB).');
    text = fs.readFileSync(source.file, 'utf8');
  }
  if (text.length > MAX_BYTES) throw new Error('A fonte é grande demais (mais de 64 MB).');
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('O conteúdo não é um JSON válido.');
  }
  return parse(data);
}

class Sources {
  // options: { file, dir }: o índice das fontes e a pasta com os itens de cada uma
  constructor(options) {
    this.options = options;
    this.index = [];
    try {
      this.index = JSON.parse(fs.readFileSync(options.file, 'utf8'));
    } catch {
      // Primeira execução.
    }
    this.cache = new Map(); // id -> itens, carregados do disco na primeira busca
    this.refreshing = false;
  }

  entriesFile(id) {
    return path.join(this.options.dir, `${id.replace(/\W/g, '_')}.json`);
  }

  entries(id) {
    if (!this.cache.has(id)) {
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(this.entriesFile(id), 'utf8'));
      } catch {
        // Arquivo perdido: a fonte fica vazia até ser atualizada.
      }
      this.cache.set(id, list.map((entry) => ({ ...entry, key: fold(entry.title) })));
    }
    return this.cache.get(id);
  }

  save() {
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
    fs.writeFileSync(this.options.file, JSON.stringify(this.index, null, 2));
  }

  store(source, parsed) {
    fs.mkdirSync(this.options.dir, { recursive: true });
    fs.writeFileSync(this.entriesFile(source.id), JSON.stringify(parsed.entries));
    this.cache.delete(source.id);
    source.name = parsed.name || source.name;
    source.count = parsed.entries.length;
    source.fetchedAt = Date.now();
    source.error = null;
    source.detached = false;
  }

  list() {
    return this.index.map(({ id, name, url, file, count, fetchedAt, error, detached }) => ({ id, name, origin: url || file, count, fetchedAt, error: error || null, detached: Boolean(detached) }));
  }

  // origin: { url } | { file }
  async add(origin) {
    const source = { id: `src:${Date.now()}`, name: null, count: 0, fetchedAt: 0, error: null };
    if (origin.file) {
      source.file = origin.file;
      source.name = path.parse(origin.file).name;
    } else {
      let url;
      try {
        url = new URL(origin.url);
      } catch {
        url = null;
      }
      if (!url || !/^https?:$/.test(url.protocol)) throw new Error('Informe a URL http(s) de um arquivo .json.');
      source.url = url.href;
      source.name = url.hostname;
    }
    const same = (other) => (source.url ? other.url === source.url : other.file && other.file.toLowerCase() === source.file.toLowerCase());
    if (this.index.some(same)) throw new Error('Esta fonte já está na lista.');
    this.store(source, await read(source));
    this.index.push(source);
    this.save();
  }

  // Lê a fonte de novo. Se falhar, os itens que já estavam guardados continuam valendo.
  async refresh(id) {
    const source = this.index.find((s) => s.id === id);
    if (!source) return;
    // Arquivo original apagado ou movido: não é erro, fica valendo a cópia guardada.
    if (source.file && !fs.existsSync(source.file)) {
      source.detached = true;
      source.error = null;
      source.fetchedAt = Date.now();
      this.save();
      return;
    }
    try {
      this.store(source, await read(source));
    } catch (err) {
      // `cause` vem nas falhas de rede do fetch, cuja mensagem não diz nada ao usuário.
      const reason = err.name === 'TimeoutError' ? 'o servidor não respondeu.' : err.cause ? 'sem conexão com o servidor.' : err.message;
      source.error = `Não deu para atualizar: ${reason}`;
      source.fetchedAt = Date.now(); // tenta de novo só depois do intervalo
      throw new Error(source.error);
    } finally {
      this.save();
    }
  }

  // Atualiza o que foi lido há mais de uma hora; devolve se alguma fonte mudou.
  async refreshStale() {
    if (this.refreshing) return false;
    this.refreshing = true;
    let changed = false;
    try {
      for (const source of [...this.index]) {
        if (Date.now() - source.fetchedAt < MAX_AGE) continue;
        await this.refresh(source.id).catch(() => {});
        changed = true;
      }
    } finally {
      this.refreshing = false;
    }
    return changed;
  }

  remove(id) {
    this.index = this.index.filter((s) => s.id !== id);
    this.cache.delete(id);
    fs.rmSync(this.entriesFile(id), { force: true });
    this.save();
  }

  // Itens cujo título contém todas as palavras de `term`, os mais recentes primeiro.
  // `only` restringe a busca a essas fontes (vazio = todas).
  search(term, only = [], limit = 100) {
    const words = fold(String(term || '')).split(/\s+/).filter(Boolean);
    const found = [];
    for (const source of this.index) {
      if (only.length && !only.includes(source.id)) continue;
      this.entries(source.id).forEach((entry, index) => {
        if (!words.every((word) => entry.key.includes(word))) return;
        found.push({ source: source.id, sourceName: source.name, index, title: entry.title, size: entry.size, date: entry.date });
      });
    }
    found.sort((a, b) => (b.date || 0) - (a.date || 0) || a.title.localeCompare(b.title, 'pt-BR'));
    return { total: found.length, items: found.slice(0, limit) };
  }

  entry(id, index) {
    return this.index.some((s) => s.id === id) ? this.entries(id)[index] || null : null;
  }
}

module.exports = { Sources };

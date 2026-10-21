// Informações dos jogos (gêneros, descrição, etc.) vindas da loja da Steam.
// É a API pública da loja: não precisa de conta nem de chave.
const STORE = 'https://store.steampowered.com/api';
const LOCALE = 'l=brazilian&cc=BR';

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { rateLimited: res.status === 429 });
  return res.json();
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function decodeEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function searchStore(term) {
  const json = await getJson(`${STORE}/storesearch/?term=${encodeURIComponent(term)}&${LOCALE}`);
  return (json.items || [])
    .filter((item) => item.type === 'app')
    .map((item) => ({ appid: String(item.id), name: item.name, image: item.tiny_image }));
}

// Tenta cada termo em ordem e só aceita nome idêntico: um palpite errado
// daria capa e descrição de outro jogo. O resto se resolve em "Corrigir informações".
async function autoMatch(terms) {
  for (const term of terms) {
    const items = await searchStore(term);
    const exact = items.find((item) => normalize(item.name) === normalize(term));
    if (exact) return exact.appid;
  }
  return null;
}

async function fetchDetails(appid) {
  const json = await getJson(`${STORE}/appdetails?appids=${appid}&${LOCALE}`);
  const data = json[appid] && json[appid].success && json[appid].data;
  // Jogo removido da loja: guarda vazio para não ficar tentando de novo.
  if (!data) return { missing: true, fetchedAt: Date.now() };
  return {
    name: data.name,
    genres: (data.genres || []).map((g) => g.description),
    developer: (data.developers || []).join(', '),
    publisher: (data.publishers || []).join(', '),
    released: (data.release_date && data.release_date.date) || null,
    description: decodeEntities(data.short_description),
    metacritic: (data.metacritic && data.metacritic.score) || null,
    fetchedAt: Date.now(),
  };
}

module.exports = { searchStore, autoMatch, fetchDetails };

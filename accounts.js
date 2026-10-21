// Biblioteca das contas GOG e Epic. Nenhuma das duas tem API pública para isso:
// o login é feito na página da própria loja e a troca do código por token usa
// as credenciais públicas dos clientes oficiais (GOG Galaxy e Epic Games
// Launcher), como fazem Heroic e Playnite. Pode parar de funcionar se as lojas
// mudarem algo. O launcher nunca vê a senha, só o token devolvido pela loja.

const TIMEOUT = 20000;

async function request(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
  // Token recusado: a GOG redireciona para o login, a Epic responde 401.
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw Object.assign(new Error('Sessão expirada. Conecte a conta de novo.'), { auth: true });
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const reason = json && (json.error_description || json.errorMessage);
    // Código ou refresh token inválido também é problema de login.
    throw Object.assign(new Error(reason || `HTTP ${res.status}`), { auth: res.status === 400 });
  }
  return json;
}

const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

// ---------- GOG ----------

const GOG_ID = '46899977096215655';
const GOG_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT = 'https://embed.gog.com/on_login_success?origin=client';

async function gogToken(params) {
  const query = new URLSearchParams({ client_id: GOG_ID, client_secret: GOG_SECRET, ...params });
  const json = await request(`https://auth.gog.com/token?${query}`);
  return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

const gog = {
  name: 'GOG',
  loginUrl: `https://auth.gog.com/auth?${new URLSearchParams({ client_id: GOG_ID, redirect_uri: GOG_REDIRECT, response_type: 'code', layout: 'client2' })}`,

  // Depois do login a GOG redireciona para on_login_success com o código na URL.
  capture(webContents, done) {
    const check = (_event, url) => {
      if (!url.startsWith('https://embed.gog.com/on_login_success')) return;
      const code = new URL(url).searchParams.get('code');
      if (code) done(code);
    };
    webContents.on('will-redirect', check);
    webContents.on('will-navigate', check);
    webContents.on('did-navigate', check);
  },

  exchange: (code) => gogToken({ grant_type: 'authorization_code', code, redirect_uri: GOG_REDIRECT }),
  refresh: (auth) => gogToken({ grant_type: 'refresh_token', refresh_token: auth.refresh }),

  async library(token) {
    const games = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      const json = await request(`https://embed.gog.com/account/getFilteredProducts?mediaType=1&page=${page}`, bearer(token));
      pages = Math.min(json.totalPages || 1, 100);
      for (const product of json.products || []) {
        if (product.isGame === false || !product.title) continue;
        games.push({
          id: `gog:${product.id}`,
          title: product.title,
          tall: null,
          wide: product.image ? `https:${product.image}_392.jpg` : null,
          launch: `goggalaxy://openGameView/${product.id}`,
        });
      }
    }
    return games;
  },
};

// ---------- Epic ----------

const EPIC_ID = '34a02cf8f4414e29b15921876da36f9a';
const EPIC_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const EPIC_REDIRECT = `https://www.epicgames.com/id/api/redirect?clientId=${EPIC_ID}&responseType=code`;
const EPIC_CATALOG = 'https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace';

async function epicToken(params) {
  const json = await request('https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${EPIC_ID}:${EPIC_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ...params, token_type: 'eg1' }).toString(),
  });
  return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

// Título e capa de um item da biblioteca; null se for DLC ou não for jogo.
async function epicDetails(token, record) {
  const fallback = { title: record.sandboxName || record.appName, tall: null, wide: null };
  let item;
  try {
    const url = `${EPIC_CATALOG}/${record.namespace}/bulk/items?id=${record.catalogItemId}`
      + '&includeDLCDetails=true&includeMainGameDetails=true&country=BR&locale=pt-BR';
    item = (await request(url, bearer(token)))[record.catalogItemId];
  } catch (err) {
    if (err.auth) throw err;
  }
  if (!item) return fallback;
  if (item.mainGameItem) return null;
  if (Array.isArray(item.categories) && item.categories.length && !item.categories.some((c) => c.path === 'games')) return null;
  const image = (type) => ((item.keyImages || []).find((i) => i.type === type) || {}).url || null;
  return { title: item.title || fallback.title, tall: image('DieselGameBoxTall'), wide: image('DieselGameBox') };
}

const epic = {
  name: 'Epic',
  loginUrl: `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(EPIC_REDIRECT)}`,

  // Depois do login a Epic mostra uma página JSON com o authorizationCode.
  capture(webContents, done) {
    webContents.on('did-finish-load', async () => {
      if (!webContents.getURL().startsWith('https://www.epicgames.com/id/api/redirect')) return;
      try {
        const body = JSON.parse(await webContents.executeJavaScript('document.body.innerText'));
        if (body.authorizationCode) done(body.authorizationCode);
      } catch {
        // Página ainda não é a do código.
      }
    });
  },

  exchange: (code) => epicToken({ grant_type: 'authorization_code', code }),
  refresh: (auth) => epicToken({ grant_type: 'refresh_token', refresh_token: auth.refresh }),

  // `known` são os jogos da consulta anterior: evita buscar os detalhes de novo.
  async library(token, known = []) {
    const records = [];
    for (let cursor = '', pages = 0; pages < 100; pages++) {
      const json = await request(
        `https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true${cursor && `&cursor=${encodeURIComponent(cursor)}`}`,
        bearer(token)
      );
      records.push(...(json.records || []));
      cursor = json.responseMetadata && json.responseMetadata.nextCursor;
      if (!cursor) break;
    }

    const previous = new Map(known.map((game) => [game.id, game]));
    // 'ue' são itens do marketplace da Unreal, não jogos.
    const pending = records.filter((r) => r.appName && r.catalogItemId && r.namespace && r.namespace !== 'ue');
    const games = new Map();
    const worker = async () => {
      for (let record = pending.shift(); record; record = pending.shift()) {
        const id = `epic:${record.appName}`;
        if (previous.has(id)) {
          games.set(id, previous.get(id));
          continue;
        }
        const details = await epicDetails(token, record);
        if (!details) continue;
        const ref = [record.namespace, record.catalogItemId, record.appName].map(encodeURIComponent).join('%3A');
        games.set(id, { id, ...details, launch: `com.epicgames.launcher://apps/${ref}?action=launch&silent=false` });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return [...games.values()];
  },
};

module.exports = { gog, epic };

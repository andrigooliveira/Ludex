// Cliente da API do Real-Debrid (https://api.real-debrid.com), usando o token
// pessoal do usuário. Serve para transformar um magnet, .torrent ou link em
// links diretos, que o gerenciador de downloads então baixa por HTTP.
const API = 'https://api.real-debrid.com/rest/1.0';

async function call(token, route, init = {}) {
  const res = await fetch(API + route, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    // 403 também vem para conta sem assinatura ativa.
    const reason = body.error === 'permission_denied' ? 'A conta do Real-Debrid não tem assinatura ativa.' : 'Token recusado pelo Real-Debrid.';
    throw Object.assign(new Error(reason), { auth: true });
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `Real-Debrid respondeu HTTP ${res.status}`);
  return body;
}

const form = (fields) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

module.exports = {
  // Dados da conta: usado para validar o token.
  user: (token) => call(token, '/user'),

  addMagnet: async (token, magnet) => (await call(token, '/torrents/addMagnet', form({ magnet }))).id,
  addTorrent: async (token, buffer) => (await call(token, '/torrents/addTorrent', { method: 'PUT', body: buffer })).id,
  selectAllFiles: (token, id) => call(token, `/torrents/selectFiles/${id}`, form({ files: 'all' })),
  // { status, progress, filename, links: [...] }
  info: (token, id) => call(token, `/torrents/info/${id}`),

  // Link de hospedagem -> { download, filename, filesize }
  unrestrict: (token, link) => call(token, '/unrestrict/link', form({ link })),
};

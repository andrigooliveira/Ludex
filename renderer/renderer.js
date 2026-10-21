const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const title = document.getElementById('title');
const telemetry = document.getElementById('telemetry');
const search = document.getElementById('search');
const toast = document.getElementById('toast');
const drawer = document.getElementById('drawer');
const catList = document.getElementById('cat-list');
const edit = document.getElementById('edit');
const editTerm = document.getElementById('edit-term');
const editResults = document.getElementById('edit-results');
const settings = document.getElementById('settings');
const sgdbKey = document.getElementById('sgdb-key');
const sgdbStatus = document.getElementById('sgdb-status');
const steamKey = document.getElementById('steam-key');
const steamStatus = document.getElementById('steam-status');

// Gênero, tempo e origem aceitam várias opções ao mesmo tempo (vale qualquer uma delas).
// `view`: 'grid' (capas) ou 'list' (lista de jogos à esquerda + página do jogo).
// `group`: como separar os jogos em seções ('none', 'source', 'category' ou 'status').
const DEFAULT_FILTERS = { status: 'all', category: 'all', genre: [], time: [], source: [], sort: 'name', view: 'grid', group: 'source' };
const filters = structuredClone(DEFAULT_FILTERS);
try {
  const saved = JSON.parse(localStorage.getItem('filters')) || {};
  for (const [key, fallback] of Object.entries(DEFAULT_FILTERS)) {
    // Ignora valores de versões antigas que não têm o formato atual.
    if (key in saved && Array.isArray(saved[key]) === Array.isArray(fallback)) filters[key] = saved[key];
  }
} catch {
  // Sem filtros guardados.
}

// Faixas de tempo de jogo, em minutos.
const TIME_RANGES = [
  { value: 'never', label: 'Nunca jogado', test: (m) => m === 0 },
  { value: 'lt2', label: 'Menos de 2 h', test: (m) => m > 0 && m < 120 },
  { value: '2to10', label: 'De 2 a 10 h', test: (m) => m >= 120 && m < 600 },
  { value: '10to50', label: 'De 10 a 50 h', test: (m) => m >= 600 && m < 3000 },
  { value: 'gt50', label: 'Mais de 50 h', test: (m) => m >= 3000 },
];

const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');
const SORTS = [
  { value: 'name', label: 'Nome', compare: byName },
  { value: 'playtime', label: 'Tempo de jogo (maior)', compare: (a, b) => b.playtimeMinutes - a.playtimeMinutes || byName(a, b) },
  { value: 'playtime-asc', label: 'Tempo de jogo (menor)', compare: (a, b) => a.playtimeMinutes - b.playtimeMinutes || byName(a, b) },
  { value: 'recent', label: 'Jogados recentemente', compare: (a, b) => b.lastPlayed - a.lastPlayed || byName(a, b) },
  { value: 'size', label: 'Tamanho no disco (maior)', compare: (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0) || byName(a, b) },
];

const GROUPS = [
  { value: 'none', label: 'Nenhum' },
  { value: 'source', label: 'Origem' },
  { value: 'category', label: 'Categoria' },
  { value: 'status', label: 'Situação' },
];

let games = [];
let categories = [];
// Jogos fora da lista de ocultos: é sobre eles que se contam categorias e filtros.
const shownGames = () => games.filter((g) => !g.hidden);
// Jogos cujas conquistas já foram pedidas à Steam nesta sessão.
const requestedAchievements = new Set();
// Cor de destaque por jogo: as já conhecidas nesta sessão (id -> cor ou null).
const accents = new Map();
let openId = null; // jogo aberto no menu lateral
let drawerView = 'info'; // 'info' ou 'settings'
let selectedId = null; // jogo mostrado na página (visualização em lista)
let pageView = 'info';
// Grupos recolhidos na lista de jogos.
const collapsed = new Set();
try {
  for (const id of JSON.parse(localStorage.getItem('collapsed')) || []) collapsed.add(id);
} catch {
  // Nenhum grupo recolhido.
}
let editId = null; // jogo aberto em "Corrigir informações"
let toastTimer;
const achievementsCache = new Map();

function showToast(message) {
  toast.textContent = message;
  toast.hidden = true;
  void toast.offsetWidth; // reinicia a animação de entrada
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, Math.max(3000, message.length * 60));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Ícone do Lucide (SVGs fixos gerados em icons.js).
function icon(name) {
  const node = el('span', 'ico');
  node.innerHTML = ICONS[name];
  return node;
}

function button(label, iconName, onClick, className) {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  if (label) node.append(label);
  node.addEventListener('click', onClick);
  return node;
}

function formatPlaytime(minutes) {
  if (!minutes) return 'Nunca jogado';
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
}

const formatDate = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleDateString('pt-BR') : null);
const pad = (number) => String(number).padStart(3, '0');

// ---------- Dropdowns ----------

const dropdowns = [];

// Dropdown próprio: `multiple` marca várias opções e fica aberto; sem ele, escolhe uma e fecha.
function createDropdown(id, { title: name, multiple, options, selected, onChange }) {
  const root = document.getElementById(id);
  root.className = 'dropdown';
  const trigger = el('button', 'dd-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'menu');
  const panel = el('div', 'dd-panel');
  panel.setAttribute('role', 'menu');
  panel.hidden = true;
  root.append(trigger, panel);

  const isOn = (value) => (multiple ? selected().includes(value) : selected() === value);

  function update() {
    const all = options();
    const chosen = all.filter((o) => isOn(o.value));
    let label = name;
    if (!multiple) label = chosen[0] ? `${name}: ${chosen[0].label}` : name;
    else if (chosen.length === 1) label = chosen[0].label;
    else if (chosen.length > 1) label = `${name} [${chosen.length}]`;
    trigger.replaceChildren(el('span', 'dd-label', label), icon('chevron-down'));
    trigger.classList.toggle('active', Boolean(multiple) && chosen.length > 0);
    trigger.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) return;

    const items = all.map((option) => {
      const item = el('button', 'dd-item');
      item.type = 'button';
      item.setAttribute('role', multiple ? 'menuitemcheckbox' : 'menuitemradio');
      item.setAttribute('aria-checked', String(isOn(option.value)));
      const box = el('span', 'dd-box');
      box.append(icon('check'));
      item.append(box, el('span', 'dd-text', option.label));
      if (option.count !== undefined) item.append(el('span', 'dd-count', pad(option.count)));
      item.addEventListener('click', () => {
        if (!multiple) {
          close();
          onChange(option.value);
          return;
        }
        const current = selected();
        onChange(current.includes(option.value) ? current.filter((v) => v !== option.value) : [...current, option.value]);
      });
      return item;
    });
    if (!items.length) items.push(el('p', 'dd-empty', 'Nada para filtrar ainda.'));
    if (multiple && chosen.length) items.push(button('Limpar seleção', 'x', () => onChange([]), 'dd-clear'));
    const scroll = panel.scrollTop;
    panel.replaceChildren(...items);
    panel.scrollTop = scroll;
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    update();
  }

  trigger.addEventListener('click', () => {
    const opening = panel.hidden;
    for (const other of dropdowns) other.close();
    panel.hidden = !opening;
    update();
  });

  const dropdown = { root, update, close };
  dropdowns.push(dropdown);
  return dropdown;
}

// Clique fora ou Esc fecha. composedPath vale mesmo se o item clicado já foi redesenhado.
document.addEventListener('click', (event) => {
  const path = event.composedPath();
  for (const dropdown of dropdowns) if (!path.includes(dropdown.root)) dropdown.close();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') for (const dropdown of dropdowns) dropdown.close();
});

// Opções com contagem, incluindo as já escolhidas que sumiram da lista.
function countedOptions(values, selected) {
  const counts = new Map(selected.map((value) => [value, 0]));
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts]
    .map(([value, total]) => ({ value, label: value, count: total }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

createDropdown('f-genre', {
  title: 'Gênero',
  multiple: true,
  options: () => countedOptions(shownGames().flatMap((g) => g.genres), filters.genre),
  selected: () => filters.genre,
  onChange: (value) => setFilter('genre', value),
});
createDropdown('f-time', {
  title: 'Tempo de jogo',
  multiple: true,
  options: () => TIME_RANGES.map((range) => ({ ...range, count: shownGames().filter((g) => range.test(g.playtimeMinutes)).length })),
  selected: () => filters.time,
  onChange: (value) => setFilter('time', value),
});
createDropdown('f-source', {
  title: 'Origem',
  multiple: true,
  options: () => countedOptions(shownGames().map((g) => g.source), filters.source),
  selected: () => filters.source,
  onChange: (value) => setFilter('source', value),
});
createDropdown('f-group', {
  title: 'Separar por',
  options: () => GROUPS,
  selected: () => filters.group,
  onChange: (value) => setFilter('group', value),
});
createDropdown('f-sort', {
  title: 'Ordem',
  options: () => SORTS,
  selected: () => filters.sort,
  onChange: (value) => setFilter('sort', value),
});

// ---------- Filtros ----------

function saveFilters() {
  try {
    localStorage.setItem('filters', JSON.stringify(filters));
  } catch {
    // Sem armazenamento: os filtros valem só até fechar.
  }
}

function setFilter(key, value) {
  filters[key] = value;
  saveFilters();
  render(true);
}

function clearFilters(everything) {
  Object.assign(filters, { status: 'all', genre: [], time: [], source: [] });
  if (everything) {
    filters.category = 'all';
    search.value = '';
  }
  saveFilters();
  render(true);
}

function syncFilterControls() {
  for (const option of document.querySelectorAll('#f-status button')) {
    option.setAttribute('aria-pressed', String(option.dataset.value === filters.status));
  }
  for (const option of document.querySelectorAll('#f-view button')) {
    option.setAttribute('aria-pressed', String(option.dataset.value === filters.view));
  }
  for (const dropdown of dropdowns) dropdown.update();
  const active = filters.status !== 'all' || filters.genre.length || filters.time.length || filters.source.length;
  document.getElementById('f-clear').hidden = !active;
}

for (const option of document.querySelectorAll('#f-status button')) {
  option.addEventListener('click', () => setFilter('status', option.dataset.value));
}
for (const option of document.querySelectorAll('#f-view button')) {
  option.addEventListener('click', () => setFilter('view', option.dataset.value));
}
document.getElementById('f-clear').addEventListener('click', () => clearFilters(false));

function visibleGames() {
  const term = search.value.trim().toLowerCase();
  const ranges = TIME_RANGES.filter((range) => filters.time.includes(range.value));
  const sort = SORTS.find((s) => s.value === filters.sort) || SORTS[0];
  // Jogos ocultos só aparecem na seção "Ocultos".
  const showHidden = filters.category === 'hidden';
  return games.filter((g) => g.name.toLowerCase().includes(term)
    && g.hidden === showHidden
    && (filters.status === 'all' || (filters.status === 'installed') === g.installed)
    // Na lista as categorias viram grupos, então não filtram.
    && (showHidden || filters.view === 'list' || filters.category === 'all' || (filters.category === 'none' ? !g.categories.length : g.categories.includes(filters.category)))
    && (!filters.genre.length || g.genres.some((genre) => filters.genre.includes(genre)))
    && (!filters.source.length || filters.source.includes(g.source))
    && (!ranges.length || ranges.some((range) => range.test(g.playtimeMinutes))))
    .sort(sort.compare);
}

// ---------- Categorias (barra lateral) ----------

// Campo de texto de uma linha: Enter confirma, Esc cancela, sair do campo confirma.
function inlineInput(value, placeholder, onDone) {
  const input = el('input', 'cat-input');
  input.type = 'text';
  input.maxLength = 40;
  input.value = value;
  input.placeholder = placeholder;
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    onDone(save ? input.value.trim() : null);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') {
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (event) => event.stopPropagation());
  return input;
}

// Botões de renomear e apagar de uma categoria; `row` é a linha que eles controlam.
function categoryTools(id, name, row) {
  const tools = el('span', 'cat-tools');
  const rename = button('', 'pencil', (event) => {
    event.stopPropagation();
    const input = inlineInput(name, 'Nome da categoria', async (value) => {
      if (value && value !== name && !(await window.launcher.renameCategory(id, value))) {
        showToast('Já existe uma categoria com esse nome');
      }
      load();
    });
    row.replaceWith(input);
    input.select();
  });
  rename.title = 'Renomear';
  // Apagar pede um segundo clique no próprio botão, em vez de uma janela de confirmação.
  const remove = button('', 'trash-2', async (event) => {
    event.stopPropagation();
    if (!remove.classList.contains('confirm')) {
      remove.classList.add('confirm');
      remove.replaceChildren('Apagar?');
      rename.hidden = true;
      row.classList.add('confirming');
      setTimeout(() => { if (remove.isConnected) render(false); }, 3000);
      return;
    }
    await window.launcher.deleteCategory(id);
    load();
  });
  remove.title = 'Apagar categoria (os jogos continuam na biblioteca)';
  tools.append(rename, remove);
  return tools;
}

function categoryRow({ id, name, iconName, total, editable }) {
  const row = el('div', 'cat');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.classList.toggle('active', filters.category === id);
  row.classList.toggle('editable', Boolean(editable));
  const select = () => setFilter('category', id);
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === row) select();
  });
  const totalNode = el('data', 'cat-count', pad(total));
  totalNode.value = total;
  row.append(icon(iconName), el('span', 'cat-name', name), totalNode);
  row.title = name;

  if (editable) row.append(categoryTools(id, name, row));
  return row;
}

// Miniatura do jogo na lista; sem imagem, um ícone genérico.
function thumbnail(game) {
  if (!game.thumb) return icon('gamepad-2');
  const img = el('img', 'thumb');
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => img.replaceWith(icon('gamepad-2'));
  img.src = game.thumb;
  return img;
}

function selectGame(id) {
  selectedId = id;
  pageView = 'info';
  render(false);
  window.scrollTo(0, 0);
}

// Divide os jogos em seções conforme "Separar por"; null = sem separação.
function groupGames(visible) {
  if (filters.group === 'source') {
    return [...new Set(visible.map((g) => g.source))].sort()
      .map((source) => ({ id: `source:${source}`, name: source, games: visible.filter((g) => g.source === source) }));
  }
  if (filters.group === 'status') {
    return [
      { id: 'installed', name: 'Instalados', games: visible.filter((g) => g.installed) },
      { id: 'missing', name: 'Não instalados', games: visible.filter((g) => !g.installed) },
    ];
  }
  if (filters.group === 'category') {
    return [
      ...categories.map((c) => ({ id: c.id, name: c.name, editable: true, games: visible.filter((g) => g.categories.includes(c.id)) })),
      { id: 'none', name: 'Sem categoria', games: visible.filter((g) => !g.categories.length) },
    ];
  }
  return null;
}

// Linha da barra lateral que entra e sai da seção de jogos ocultos.
function hiddenRow() {
  const total = games.filter((g) => g.hidden).length;
  if (filters.category === 'hidden') {
    return categoryRow({ id: 'all', name: 'Voltar à biblioteca', iconName: 'arrow-left', total: shownGames().length });
  }
  return total ? categoryRow({ id: 'hidden', name: 'Ocultos', iconName: 'eye-off', total }) : null;
}

// Lista de jogos em grupos. Sem separação escolhida, agrupa como a Steam:
// instalados, cada categoria e o resto.
function renderGameList(visible) {
  const groups = groupGames(visible) || [
    { id: 'installed', name: 'Instalados', games: visible.filter((g) => g.installed) },
    ...categories.map((c) => ({ id: c.id, name: c.name, editable: true, games: visible.filter((g) => g.categories.includes(c.id)) })),
    { id: 'none', name: 'Sem categoria', games: visible.filter((g) => !g.installed && !g.categories.length) },
  ];

  const nodes = [];
  for (const group of groups) {
    if (!group.games.length && !group.editable) continue;
    const open = !collapsed.has(group.id);
    const head = el('div', open ? 'group-head cat' : 'group-head cat closed');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(open));
    head.classList.toggle('editable', Boolean(group.editable));
    const toggle = () => {
      if (open) collapsed.add(group.id);
      else collapsed.delete(group.id);
      try {
        localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
      } catch {
        // Sem armazenamento: vale só até fechar.
      }
      render(false);
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === head) toggle();
    });
    head.append(icon('chevron-down'), el('span', 'cat-name', group.name), el('span', 'cat-count', pad(group.games.length)));
    if (group.editable) head.append(categoryTools(group.id, group.name, head));
    nodes.push(head);

    for (const game of open ? group.games : []) {
      const row = el('div', 'game-row');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.classList.toggle('active', game.id === selectedId);
      paintAccent(row, game, false);
      row.classList.toggle('missing', !game.installed);
      row.title = game.name;
      row.addEventListener('click', () => selectGame(game.id));
      withGameMenu(row, game);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') selectGame(game.id);
      });
      row.append(thumbnail(game), el('span', 'cat-name', game.name));
      nodes.push(row);
    }
  }
  const hidden = hiddenRow();
  if (hidden) nodes.push(hidden);
  catList.replaceChildren(...nodes);
}

function renderSidebar(visible) {
  document.getElementById('side-title').textContent = filters.view === 'list' ? 'Jogos' : 'Categorias';
  if (filters.view === 'list') renderGameList(visible);
  else renderCategoryList();
}

function renderCategoryList() {
  const shown = shownGames();
  const rows = [categoryRow({ id: 'all', name: 'Todos os jogos', iconName: 'layout-grid', total: shown.length })];
  for (const category of categories) {
    const total = shown.filter((g) => g.categories.includes(category.id)).length;
    rows.push(categoryRow({ id: category.id, name: category.name, iconName: 'folder', total, editable: true }));
  }
  if (categories.length) {
    rows.push(categoryRow({ id: 'none', name: 'Sem categoria', iconName: 'folder-open', total: shown.filter((g) => !g.categories.length).length }));
  }
  const hidden = filters.category === 'hidden'
    ? categoryRow({ id: 'hidden', name: 'Ocultos', iconName: 'eye-off', total: games.length - shown.length })
    : hiddenRow();
  if (hidden) rows.push(hidden);
  catList.replaceChildren(...rows);
}

document.getElementById('cat-new').addEventListener('click', () => {
  if (catList.querySelector('.cat-input')) return;
  const input = inlineInput('', 'Nome da categoria', async (value) => {
    if (value) await window.launcher.createCategory(value);
    load();
  });
  catList.append(input);
  input.focus();
});

document.getElementById('cat-import').addEventListener('click', async () => {
  const { collections, hidden } = await window.launcher.importSteamCategories();
  showToast(collections || hidden
    ? `Importado da Steam: ${collections} coleções e ${hidden} jogos ocultos`
    : 'Nenhuma coleção encontrada na Steam');
  load();
});

// ---------- Cabeçalho da categoria ----------

function renderMasthead(visible) {
  const category = categories.find((c) => c.id === filters.category);
  const fixed = { none: 'Sem categoria', hidden: 'Ocultos' };
  const name = category ? category.name : fixed[filters.category] || 'Biblioteca';
  if (title.textContent !== name) {
    title.textContent = name;
    title.classList.remove('reveal');
    void title.offsetWidth; // reinicia a animação de revelação
    title.classList.add('reveal');
  }

  const minutes = visible.reduce((sum, g) => sum + g.playtimeMinutes, 0);
  const recent = visible.reduce((sum, g) => sum + g.recentMinutes, 0);
  const hours = (value) => (value / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const rows = [
    ['Exibindo', `${pad(visible.length)} / ${pad(games.filter((g) => g.hidden === (filters.category === 'hidden')).length)}`],
    ['Instalados', pad(visible.filter((g) => g.installed).length)],
    ['Horas jogadas', hours(minutes)],
    ['Últimas 2 semanas', `${hours(recent)} h`],
    ['Espaço usado', formatBytes(visible.reduce((sum, g) => sum + (g.sizeBytes || 0), 0))],
  ];
  telemetry.replaceChildren(...rows.flatMap(([label, value]) => [el('dt', null, label), el('dd', null, value)]));
}

// ---------- Grade ----------

// Tenta cada capa em ordem; se nenhuma carregar, mostra o ícone ou o nome no lugar.
function buildCover(game) {
  const cover = el('div', 'cover');
  const fallback = () => {
    if (game.icon) {
      const exeIcon = el('img', 'exe-icon');
      exeIcon.src = game.icon;
      exeIcon.alt = '';
      cover.prepend(exeIcon);
    } else {
      cover.prepend(el('div', 'fallback', game.name));
    }
  };

  if (game.covers.length) {
    const queue = [...game.covers];
    const img = el('img', 'art');
    img.alt = ''; // o nome do jogo já está escrito ao lado
    img.loading = 'lazy';
    img.onerror = () => {
      if (queue.length) {
        img.src = queue.shift();
      } else {
        img.remove();
        fallback();
      }
    };
    img.src = queue.shift();
    cover.append(img);
  } else {
    fallback();
  }

  cover.append(el('span', 'tag', game.source));
  if (game.runningSince) cover.append(el('span', 'tag note live', 'Em execução'));
  else if (!game.installed) cover.append(el('span', 'tag note', 'Não instalado'));
  else if (!game.ready) cover.append(el('span', 'tag note alert', 'Atualização pendente'));
  return cover;
}

function stat(iconName, text) {
  const node = el('span', 'stat');
  node.append(icon(iconName), text);
  return node;
}

async function launch(game) {
  showToast(game.installed ? `Iniciando ${game.name}` : `Abrindo ${game.name} na ${game.source} para instalar`);
  const result = await window.launcher.launch(game.id);
  if (!result.ok) showToast(`Não deu para iniciar: ${result.error}`);
}

function buildCard(game, index) {
  const card = el('article', game.installed ? 'card' : 'card missing');
  card.tabIndex = 0;
  card.title = game.name;
  card.style.setProperty('--i', Math.min(index, 30));
  paintAccent(card, game, false);
  card.addEventListener('click', () => openDrawer(game.id));
  withGameMenu(card, game);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === card) openDrawer(game.id);
  });

  const cover = buildCover(game);
  const play = button('', game.installed ? 'play' : 'download', (event) => {
    event.stopPropagation();
    launch(game);
  }, 'primary quick-play');
  play.title = `${game.installed ? 'Jogar' : 'Instalar'} ${game.name}`;
  cover.append(play);

  const sub = el('div', 'sub');
  sub.append(stat('clock', formatPlaytime(game.playtimeMinutes)));
  if (game.achievements) sub.append(stat('trophy', `${game.achievements.unlocked}/${game.achievements.total}`));

  card.append(cover, el('div', 'name', game.name), sub);
  return card;
}

// A grade, inteira ou dividida em seções com um separador (nome + contagem) cada.
function buildShelves(visible) {
  let index = 0;
  const cards = (list) => {
    const node = el('div', 'cards');
    node.append(...list.map((game) => buildCard(game, index++)));
    return node;
  };
  const groups = groupGames(visible);
  if (!groups) return [cards(visible)];
  return groups.filter((group) => group.games.length).map((group) => {
    const shelf = el('section', 'shelf');
    const separator = el('div', 'separator');
    separator.append(el('h2', null, group.name), el('span', null, `${pad(group.games.length)} ${group.games.length === 1 ? 'jogo' : 'jogos'}`));
    shelf.append(separator, cards(group.games));
    return shelf;
  });
}

// Estado vazio com a próxima ação à mão, em vez de uma tela em branco.
function renderEmpty(hasVisible) {
  empty.hidden = hasVisible;
  if (hasVisible) return;
  const filtered = games.length > 0;
  empty.replaceChildren(
    el('h2', null, filtered ? 'Nenhum jogo com esses filtros' : 'Nenhum jogo encontrado'),
    el('p', null, filtered
      ? 'Mude a busca, os filtros ou a categoria para ver mais jogos.'
      : 'Adicione um executável ou conecte a sua conta Steam nas configurações.'),
    filtered
      ? button('Limpar busca e filtros', 'x', () => clearFilters(true), 'primary')
      : button('Adicionar executável', 'plus', () => document.getElementById('add').click(), 'primary')
  );
}

// ---------- Menu do jogo (painel lateral) ----------

function tile(iconName, label, value) {
  const node = el('div', 'tile');
  const head = el('span', 'label');
  head.append(icon(iconName), label);
  const data = el('data', null, value);
  data.title = value;
  node.append(head, data);
  return node;
}

function buildAchievements(game) {
  const { unlocked, total } = game.achievements;
  const section = el('section');
  const heading = el('div', 'section-title');
  const h3 = el('h3');
  h3.append(icon('trophy'), 'Conquistas');
  heading.append(h3, el('span', null, `${pad(unlocked)} / ${pad(total)}`));
  const bar = el('progress');
  bar.max = total;
  bar.value = unlocked;
  const list = el('div', 'ach-list');
  section.append(heading, bar, list);

  const fill = (data) => {
    if (!data) return;
    list.replaceChildren(...data.items.map((item) => {
      const row = el('div', item.unlocked ? 'ach' : 'ach locked');
      if (item.icon) {
        const img = el('img');
        img.src = item.icon;
        img.alt = '';
        img.loading = 'lazy';
        row.append(img);
      }
      const text = el('div', 'ach-text');
      text.append(el('strong', null, item.name));
      text.append(el('span', null, item.description || (item.hidden && !item.unlocked ? 'Conquista secreta' : '')));
      row.append(text);
      if (item.unlocked) row.append(el('span', 'ach-date', formatDate(item.unlockedAt) || 'Desbloqueada'));
      return row;
    }));
  };
  // Mostra o que já está em memória e atualiza em seguida.
  fill(achievementsCache.get(game.id));
  window.launcher.achievements(game.id).then((data) => {
    achievementsCache.set(game.id, data);
    if (list.isConnected) fill(data);
  });
  return section;
}

function buildTiles(game) {
  const tiles = el('div', 'tiles');
  tiles.append(
    tile('clock', 'Jogado', formatPlaytime(game.playtimeMinutes)),
    tile('activity', '2 semanas', game.recentMinutes ? formatPlaytime(game.recentMinutes) : '—'),
    ...(game.installed ? [tile('folder', 'No disco', game.sizeBytes ? formatBytes(game.sizeBytes) : 'Medindo...')] : []),
    tile('calendar', 'Última vez', formatDate(game.lastPlayed) || 'Nunca'),
    tile('trophy', 'Conquistas', game.achievements ? `${game.achievements.unlocked}/${game.achievements.total}` : 'Sem dados')
  );
  return tiles;
}

// Descrição e ficha do jogo. `withExtras` inclui também os números e as conquistas
// (no painel lateral vai tudo junto; na página eles têm lugar próprio).
function buildInfo(game, withExtras = true) {
  const nodes = [];
  if (game.description) nodes.push(el('p', 'description', game.description));
  if (withExtras) nodes.push(buildTiles(game));

  const facts = el('dl', 'facts');
  const rows = [
    ['Versão', game.installed ? game.version || 'Não informada pelo jogo' : null],
    ['Atualizado em', formatDate(game.updated)],
    ['Desenvolvedor', game.developer],
    ['Lançamento', game.released],
    ['Metacritic', game.metacritic && String(game.metacritic)],
  ];
  for (const [label, value] of rows) {
    if (value) facts.append(el('dt', null, label), el('dd', null, value));
  }
  if (facts.children.length) nodes.push(facts);

  if (withExtras && game.achievements) nodes.push(buildAchievements(game));
  return nodes;
}

function option(iconName, name, description, onClick, className) {
  const node = el('button', className ? `option ${className}` : 'option');
  node.type = 'button';
  const text = el('span', 'option-text');
  text.append(el('strong', null, name), el('span', null, description));
  node.append(icon(iconName), text, icon('chevron-right'));
  node.addEventListener('click', onClick);
  return node;
}

// Marcar/desmarcar as categorias do jogo e criar uma nova já com ele dentro.
function buildGameCategories(game) {
  const section = el('section');
  const heading = el('h3');
  heading.append(icon('folder'), 'Categorias');
  section.append(heading);

  if (categories.length) {
    const checks = el('div', 'checks');
    for (const category of categories) {
      const on = game.categories.includes(category.id);
      const row = el('button', 'check-row');
      row.type = 'button';
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', String(on));
      const box = el('span', 'dd-box');
      box.append(icon('check'));
      row.append(box, category.name);
      row.addEventListener('click', async () => {
        await window.launcher.setGameCategory(category.id, game.id, !on);
        load();
      });
      checks.append(row);
    }
    section.append(checks);
  } else {
    section.append(el('p', 'hint', 'Você ainda não criou nenhuma categoria. Crie a primeira aqui embaixo.'));
  }

  const form = el('form', 'row');
  const input = el('input');
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = 'Nova categoria';
  const add = el('button');
  add.type = 'submit';
  add.append(icon('folder-plus'), 'Criar');
  form.append(input, add);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = input.value.trim() && await window.launcher.createCategory(input.value);
    if (!id) return;
    await window.launcher.setGameCategory(id, game.id, true);
    load();
  });
  section.append(form);
  return section;
}

async function setHidden(game, hidden) {
  await window.launcher.setHidden(game.id, hidden);
  if (drawer.open) drawer.close();
  showToast(hidden ? `${game.name} foi ocultado` : `${game.name} voltou à biblioteca`);
  load();
}

// Pinta `node` com a cor de destaque do jogo (variável --accent, que os estilos
// já usam). Sem cor conhecida fica o vermelho padrão; com `fetch`, pede a cor
// ao processo principal, que a calcula a partir da capa.
function paintAccent(node, game, fetch) {
  const color = accents.has(game.id) ? accents.get(game.id) : game.accent;
  if (color) node.style.setProperty('--accent', color);
  else node.style.removeProperty('--accent');
  if (color || !fetch || accents.has(game.id)) return;
  accents.set(game.id, null);
  window.launcher.accent(game.id).then((found) => {
    accents.set(game.id, found);
    // Só pinta se o painel ainda mostra este jogo.
    const current = node === drawer ? openId : selectedId;
    if (found && current === game.id) node.style.setProperty('--accent', found);
  });
}

// Jogo da Steam sem conquistas conhecidas (não instalado, por exemplo): pede à
// Steam uma vez por sessão. Se vier algo, o processo principal avisa e a tela recarrega.
function requestAchievements(game) {
  if (game.source !== 'Steam' || game.achievements || requestedAchievements.has(game.id)) return;
  requestedAchievements.add(game.id);
  window.launcher.achievements(game.id);
}

// A desinstalação acontece fora do launcher (loja ou desinstalador), então não
// há aviso de quando termina: relê a lista algumas vezes e sempre que a janela
// voltar ao foco, por alguns minutos. Sem mudança nos dados, load() não refaz a tela.
let uninstallWatch = 0;
function watchUninstall() {
  uninstallWatch = Date.now() + 10 * 60 * 1000;
  load();
  for (const delay of [15, 45, 120]) setTimeout(() => load(), delay * 1000);
}
window.addEventListener('focus', () => {
  if (Date.now() < uninstallWatch) load();
});

// O que dá para fazer com um jogo: a mesma lista alimenta as Configurações do
// jogo e o menu do botão direito.
function gameActions(game) {
  const actions = [];
  const add = (iconName, name, description, run, danger) => actions.push({ icon: iconName, name, description, run, danger: Boolean(danger) });
  if (game.source !== 'Steam') add('pencil', 'Corrigir informações', 'Escolher o jogo certo para capa, gêneros e descrição', () => openEdit(game));
  add('image', 'Trocar capa', 'Usar uma imagem do seu computador', async () => {
    if (await window.launcher.pickCover(game.id)) load();
  });
  if (game.canChangeExe) {
    add('file-cog', 'Alterar executável', `Escolher outro arquivo para abrir o jogo (hoje: ${game.exeName})`, async () => {
      const result = await window.launcher.changeExe(game.id);
      if (result.error || result.message) showToast(result.error || result.message);
      if (result.ok) load();
    });
  }
  if (game.installed) {
    add('save', 'Saves', game.lastBackup ? `Backup e restauração · último backup em ${new Date(game.lastBackup).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Backup e restauração dos saves', () => openBackups(game));
  }
  if (game.hasFolder) add('folder-open', 'Abrir pasta do jogo', 'Mostrar os arquivos no Explorador', () => window.launcher.openFolder(game.id));
  if (game.hidden) add('eye', 'Mostrar de novo', 'Devolve o jogo à biblioteca', () => setHidden(game, false));
  else add('eye-off', 'Ocultar jogo', 'Tira da biblioteca sem apagar nada; fica em "Ocultos"', () => setHidden(game, true));
  if (game.canUninstall) {
    const how = game.source === 'Manual'
      ? 'Abre o desinstalador do próprio jogo'
      : game.source === 'Epic' ? 'Abre o launcher da Epic, que é quem desinstala' : `Abre a desinstalação da ${game.source}`;
    add('trash-2', 'Desinstalar', how, async () => {
      const result = await window.launcher.uninstall(game.id);
      if (result.error || result.message) showToast(result.error || result.message);
      if (result.removed && drawer.open) drawer.close();
      if (result.ok) watchUninstall();
    }, true);
  }
  if (game.source === 'Manual') {
    add('trash-2', 'Remover da biblioteca', 'Tira o jogo da lista; os arquivos continuam no disco', async () => {
      await window.launcher.remove(game.id);
      if (drawer.open) drawer.close();
      load();
    }, true);
  }
  return actions;
}

// ---------- Menu do botão direito ----------

const gameMenu = el('div');
gameMenu.id = 'game-menu';
gameMenu.setAttribute('role', 'menu');
gameMenu.hidden = true;
document.body.append(gameMenu);
let gameMenuFor = null; // id do jogo do menu aberto

function closeGameMenu() {
  gameMenu.hidden = true;
  gameMenuFor = null;
}

function openGameMenu(game, x, y) {
  gameMenuFor = game.id;
  // Cor do jogo no botão principal: a já conhecida ou, quando chegar, a calculada da capa.
  const color = accents.has(game.id) ? accents.get(game.id) : game.accent;
  if (color) gameMenu.style.setProperty('--game', color);
  else gameMenu.style.removeProperty('--game');
  if (!color && !accents.has(game.id)) {
    accents.set(game.id, null);
    window.launcher.accent(game.id).then((found) => {
      accents.set(game.id, found);
      if (found && gameMenuFor === game.id) gameMenu.style.setProperty('--game', found);
    });
  }

  const pick = (run) => () => {
    closeGameMenu();
    run();
  };
  const play = game.runningSince
    ? button('Em execução', 'activity', pick(() => showToast(`${game.name} está aberto`)), 'gm-play install')
    : game.installed
      ? button('Jogar', 'play', pick(() => launch(game)), 'gm-play')
      : button('Instalar', 'download', pick(() => launch(game)), 'gm-play install');
  const title = el('div', 'gm-title', game.name);
  title.title = game.name;
  gameMenu.replaceChildren(title, play, ...gameActions(game).map((action) => {
    const item = button(action.name, action.icon, pick(action.run), action.danger ? 'gm-item danger' : 'gm-item');
    item.title = action.description;
    item.setAttribute('role', 'menuitem');
    return item;
  }));

  // Abre no ponteiro, sem sair da janela.
  gameMenu.hidden = false;
  const box = gameMenu.getBoundingClientRect();
  gameMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
  gameMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
}

// Liga o menu a um card ou a uma linha da lista.
function withGameMenu(node, game) {
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openGameMenu(game, event.clientX, event.clientY);
  });
}

// Clique fora, Esc, rolagem ou troca de janela fecham.
document.addEventListener('click', (event) => {
  if (!gameMenu.hidden && !event.composedPath().includes(gameMenu)) closeGameMenu();
});
document.addEventListener('contextmenu', () => closeGameMenu());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeGameMenu();
});
window.addEventListener('scroll', closeGameMenu, true);
window.addEventListener('resize', closeGameMenu);
window.addEventListener('blur', closeGameMenu);

function buildGameSettings(game, onBack) {
  const options = el('div', 'options');
  options.append(...gameActions(game).map((action) => option(action.icon, action.name, action.description, action.run, action.danger ? 'danger' : undefined)));

  const back = button('Voltar', 'arrow-left', onBack, 'back');
  return [back, buildGameCategories(game), options];
}

// Linha de identificação do jogo: origem, id na Steam e situação.
function buildPath(game) {
  const path = el('span', 'path');
  const rest = [];
  if (game.source === 'Steam') rest.push(`ID ${game.appid}`);
  if (!game.installed) rest.push('Não instalado');
  path.append(el('b', null, `[ ${game.source} ]`), rest.map((part) => ` // ${part}`).join(''));
  return path;
}

// Categorias e gêneros do jogo como etiquetas.
function buildChips(game) {
  const chips = el('div', 'genres');
  for (const category of categories.filter((c) => game.categories.includes(c.id))) {
    const chip = el('span', 'genre cat-chip');
    chip.append(icon('folder'), category.name);
    chips.append(chip);
  }
  chips.append(...game.genres.map((g) => el('span', 'genre', g)));
  return chips;
}

// Os dois botões do menu do jogo: jogar (ou instalar) e configurações.
function buildMenuButtons(game, view, setView) {
  const config = button('Configurações', 'settings', () => setView(view === 'settings' ? 'info' : 'settings'));
  config.setAttribute('aria-pressed', String(view === 'settings'));
  const main = game.runningSince
    ? button('Em execução', 'activity', () => showToast(`${game.name} está aberto`), 'primary install')
    : game.installed
      ? button('Jogar', 'play', () => launch(game), 'primary')
      : button('Instalar', 'download', () => launch(game), 'primary install');
  return [main, config];
}

// `fresh` = painel recém-aberto ou troca de aba: anima a entrada e volta ao topo.
function renderDrawer(fresh) {
  const game = games.find((g) => g.id === openId);
  if (!game) {
    drawer.close();
    return;
  }
  requestAchievements(game);
  paintAccent(drawer, game, true);
  const previous = drawer.querySelector('.drawer-body');
  const scroll = previous && !fresh ? previous.scrollTop : 0;

  const top = el('div', 'drawer-top');
  const close = button('', 'x', () => drawer.close(), 'icon-btn');
  close.title = 'Fechar';
  top.append(buildPath(game), close);

  const hero = el('div', 'hero');
  const heroText = el('div', 'hero-text');
  heroText.append(el('h2', null, game.name));
  if (game.developer) heroText.append(el('span', 'by', game.developer));
  const chips = buildChips(game);
  if (chips.children.length) heroText.append(chips);
  hero.append(buildCover(game), heroText);

  const menu = el('div', 'menu');
  menu.append(...buildMenuButtons(game, drawerView, setDrawerView));

  const view = el('div', fresh ? 'view' : null);
  view.append(...(drawerView === 'settings' ? buildGameSettings(game, () => setDrawerView('info')) : buildInfo(game)));

  const body = el('div', 'drawer-body');
  body.append(hero, menu, view);
  drawer.replaceChildren(top, body);
  body.scrollTop = scroll;
}

function setDrawerView(view) {
  drawerView = view;
  renderDrawer(true);
}

function openDrawer(id) {
  openId = id;
  drawerView = 'info';
  renderDrawer(true);
  if (!drawer.open) drawer.showModal();
}

// O evento chega com atraso: se o painel já foi reaberto para outro jogo, não mexe.
drawer.addEventListener('close', () => { if (!drawer.open) openId = null; });
// Clique fora do painel fecha.
for (const dlg of [drawer, edit, settings, document.getElementById('sources'), document.getElementById('files'), document.getElementById('backups')]) {
  dlg.addEventListener('click', (event) => { if (event.target === dlg) dlg.close(); });
}

// ---------- Página do jogo (visualização em lista) ----------

const page = document.getElementById('page');

function setPageView(view) {
  pageView = view;
  render(false);
}

function renderPage(game) {
  requestAchievements(game);
  paintAccent(page, game, true);
  // Só anima quando muda o jogo ou a aba, não a cada atualização em segundo plano.
  const key = `${game.id}|${pageView}`;
  const fresh = page.dataset.key !== key;
  page.dataset.key = key;

  // Banner largo do jogo; sem ele, a capa; sem nenhuma, só o título.
  const banner = el('div', 'banner');
  const art = [...game.heroes, ...game.covers.slice(0, 1)];
  if (art.length) {
    const img = el('img', fresh ? 'enter' : null);
    img.alt = '';
    img.onerror = () => {
      if (art.length) img.src = art.shift();
      else img.remove();
    };
    img.src = art.shift();
    banner.append(img);
  }
  const label = el('div', 'banner-label');
  label.append(buildPath(game), el('h2', null, game.name));
  banner.append(label);

  const bar = el('div', 'page-bar');
  bar.append(...buildMenuButtons(game, pageView, setPageView), buildTiles(game));

  const main = el('div', fresh ? 'view' : null);
  if (pageView === 'settings') {
    main.append(...buildGameSettings(game, () => setPageView('info')));
  } else {
    const chips = buildChips(game);
    if (chips.children.length) main.append(chips);
    main.append(...buildInfo(game, false));
  }
  const cols = el('div', 'page-cols');
  cols.append(main);
  if (game.achievements) cols.append(buildAchievements(game));

  page.replaceChildren(banner, bar, cols);
}

// ---------- Corrigir informações ----------

async function runSearch() {
  const term = editTerm.value.trim();
  if (!term) return;
  editResults.replaceChildren(el('p', 'hint', 'Buscando...'));
  const result = await window.launcher.search(term);
  if (!result.ok) {
    editResults.replaceChildren(el('p', 'hint', 'Não deu para consultar a loja. Confira a internet.'));
  } else if (!result.items.length) {
    editResults.replaceChildren(el('p', 'hint', 'Nenhum jogo encontrado com esse nome.'));
  } else {
    editResults.replaceChildren(...result.items.map((item) => {
      const row = el('button', 'result');
      row.type = 'button';
      if (item.image) {
        const img = el('img');
        img.src = item.image;
        img.alt = '';
        row.append(img);
      }
      row.append(el('span', 'result-name', item.name));
      row.append(el('span', 'tag-inline', item.provider === 'steam' ? 'Steam' : 'SteamGridDB · só capa'));
      row.addEventListener('click', () => applyMatch(item.provider, item.ref, item.name));
      return row;
    }));
  }
}

async function applyMatch(provider, ref, name) {
  const ok = await window.launcher.setMatch(editId, provider, ref, name);
  if (!ok) showToast('Não deu para aplicar essa escolha');
  edit.close();
  load();
}

function openEdit(game) {
  editId = game.id;
  editTerm.value = game.name;
  document.getElementById('edit-rename').hidden = game.source !== 'Manual';
  edit.showModal();
  runSearch();
}

document.getElementById('edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch();
});
document.getElementById('edit-none').addEventListener('click', () => applyMatch(null, null, null));
document.getElementById('edit-rename').addEventListener('click', async () => {
  await window.launcher.rename(editId, editTerm.value);
  edit.close();
  load();
});
document.getElementById('edit-close').addEventListener('click', () => edit.close());

// ---------- Tela principal ----------

// `animate` = a lista mudou por ação do usuário (filtro, categoria): entra em cascata.
function render(animate) {
  closeGameMenu();
  if (!big.hidden) renderBig();
  const list = filters.view === 'list';
  // A categoria escolhida pode ter sido apagada.
  if (!['all', 'none', 'hidden'].includes(filters.category) && !categories.some((c) => c.id === filters.category)) {
    filters.category = 'all';
  }
  const visible = visibleGames();
  // Na lista sempre há um jogo aberto: o escolhido ou, se ele saiu do filtro, o primeiro.
  const selected = list ? visible.find((g) => g.id === selectedId) || visible[0] : null;
  if (selected && selected.id !== selectedId) {
    selectedId = selected.id;
    pageView = 'info';
  }

  renderSidebar(visible);
  syncFilterControls();
  renderMasthead(visible);

  document.getElementById('layout').classList.toggle('list', list);
  document.getElementById('masthead').hidden = list;
  grid.hidden = list;
  page.hidden = !selected;
  if (selected) {
    renderPage(selected);
  } else if (!list) {
    grid.classList.toggle('animate', Boolean(animate));
    grid.replaceChildren(...buildShelves(visible));
  }
  renderEmpty(visible.length > 0);
  if (openId) renderDrawer(false);
}

let loadedData = null;
// Jogando agora, na barra do topo: nome e há quanto tempo. O texto só é
// reescrito quando muda (uma vez por minuto), para a tela não ficar se redesenhando.
const nowPlaying = document.getElementById('now-playing');
const nowPlayingText = document.getElementById('now-playing-text');
function renderNowPlaying() {
  const running = games.filter((g) => g.runningSince).sort((a, b) => a.runningSince - b.runningSince);
  const text = running.map((g) => `${g.name} · ${formatPlaytime(Math.max(1, Math.floor((Date.now() - g.runningSince) / 60000)))}`).join('  //  ');
  nowPlaying.hidden = !running.length;
  if (nowPlayingText.textContent !== text) nowPlayingText.textContent = text;
  nowPlaying.title = running.length ? `Jogando agora: ${text}` : '';
}
setInterval(renderNowPlaying, 20000);

async function load(force, animate) {
  [games, categories] = await Promise.all([window.launcher.list(force), window.launcher.categories()]);
  // O processo principal às vezes avisa sem nada ter mudado. Refazer a tela recria
  // as capas (elas piscam e a animação de hover do card recomeça), então só refaz
  // quando os dados são outros ou quando foi pedido com animação.
  renderNowPlaying();
  const data = JSON.stringify([games, categories]);
  if (data === loadedData && !animate) return;
  loadedData = data;
  render(animate);
}

search.addEventListener('input', () => render(false));
document.getElementById('refresh').addEventListener('click', async (event) => {
  const refresh = event.currentTarget;
  refresh.classList.add('spinning');
  await load(true, true);
  refresh.classList.remove('spinning');
  showToast('Lista atualizada');
});
document.getElementById('add').addEventListener('click', async () => {
  if (await window.launcher.add()) load();
});

// ---------- Configurações do launcher ----------

// Texto e luz (ligada/apagada) da situação de um item das configurações.
function setState(node, on, text) {
  node.dataset.on = String(Boolean(on));
  node.textContent = text;
}

async function showSettingsStatus() {
  const [info, sourceList] = await Promise.all([window.launcher.getSettings(), window.launcher.sources()]);
  setState(sgdbStatus, info.hasSgdbKey, info.hasSgdbKey ? 'Chave configurada' : 'Nenhuma chave configurada');
  document.getElementById('sgdb-clear').hidden = !info.hasSgdbKey;
  if (info.hasSteamKey) setState(steamStatus, true, `Conectada · SteamID ${info.steamId} · ${info.ownedCount ?? 0} jogos na conta`);
  else if (info.steamId) setState(steamStatus, false, `Conta encontrada · SteamID ${info.steamId} · falta a chave`);
  else setState(steamStatus, false, 'Nenhuma conta da Steam encontrada neste computador');
  document.getElementById('steam-clear').hidden = !info.hasSteamKey;
  renderAccounts(info.accounts);
  document.getElementById('dl-dir-status').textContent = info.downloadDir;
  setState(document.getElementById('rd-status'), info.hasRdToken, info.hasRdToken ? `Conectado · ${info.rdUser || 'token salvo'}` : 'Nenhum token configurado');
  document.getElementById('rd-clear').hidden = !info.hasRdToken;
  setTray.setAttribute('aria-checked', String(info.closeToTray));
  document.getElementById('set-saves-dir').textContent = info.savesDir;
  setAutoBackup.setAttribute('aria-checked', String(info.autoBackup));
  setLogin.setAttribute('aria-checked', String(info.openAtLogin));
  setLogin.disabled = !info.canOpenAtLogin;
  setLogin.title = info.canOpenAtLogin ? '' : 'Só funciona no launcher instalado';
  const total = sourceList.reduce((sum, source) => sum + source.count, 0);
  setState(document.getElementById('set-sources-status'), sourceList.length, sourceList.length
    ? `${sourceList.length} ${sourceList.length === 1 ? 'fonte' : 'fontes'} · ${total.toLocaleString('pt-BR')} itens`
    : 'Nenhuma fonte adicionada');
}

const setTray = document.getElementById('set-tray');
setTray.addEventListener('click', async () => {
  const on = setTray.getAttribute('aria-checked') !== 'true';
  setTray.setAttribute('aria-checked', String(on));
  await window.launcher.setCloseToTray(on);
});

const setAutoBackup = document.getElementById('set-autobackup');
setAutoBackup.addEventListener('click', async () => {
  const on = setAutoBackup.getAttribute('aria-checked') !== 'true';
  setAutoBackup.setAttribute('aria-checked', String(on));
  await window.launcher.setAutoBackup(on);
});
document.getElementById('set-saves-pick').addEventListener('click', async () => {
  if (await window.launcher.pickSavesDir()) showSettingsStatus();
});

const setLogin = document.getElementById('set-login');
setLogin.addEventListener('click', async () => {
  const on = setLogin.getAttribute('aria-checked') !== 'true';
  if (await window.launcher.setOpenAtLogin(on)) setLogin.setAttribute('aria-checked', String(on));
});

// Abas das configurações: a escolhida fica lembrada enquanto o app estiver aberto.
function showSettingsTab(name) {
  for (const tab of settings.querySelectorAll('.set-nav button')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of settings.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  settings.querySelector('.set-body').scrollTop = 0;
}
for (const tab of settings.querySelectorAll('.set-nav button')) tab.addEventListener('click', () => showSettingsTab(tab.dataset.tab));
showSettingsTab('accounts');

// ---------- Downloads ----------

const downloadsScreen = document.getElementById('downloads-screen');
const dlList = document.getElementById('dl-list');
const dlDoneList = document.getElementById('dl-done-list');
const dlInput = document.getElementById('dl-input');
const dlError = document.getElementById('dl-error');
const dlRd = document.getElementById('dl-rd');
const dlChart = document.getElementById('dl-chart');
const dlRows = new Map(); // id -> partes da linha, para atualizar no lugar a cada segundo
let downloadItems = [];
let downloadHistory = { global: [], items: {} };
let chartScope = null; // id do download mostrado no gráfico; null = todos somados
let chartHover = null; // posição do ponteiro sobre o gráfico (0 a 1), para manter a leitura entre redesenhos
let useRd = null; // null = segue o padrão (ligado quando há token)

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toLocaleString('pt-BR', { maximumFractionDigits: power > 2 ? 2 : power > 1 ? 1 : 0 })} ${units[power]}`;
}

const formatSpeed = (bytes) => `${formatBytes(bytes)}/s`;

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${(seconds / 3600).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
}

const MODE_NAMES = { torrent: 'Torrent', http: 'HTTP', rd: 'Real-Debrid' };
const STATUS_NAMES = { preparing: 'Preparando', choosing: 'Aguardando a escolha', downloading: 'Baixando', paused: 'Pausado', done: 'Concluído', error: 'Erro' };
const isActive = (d) => d.status === 'preparing' || d.status === 'choosing' || d.status === 'downloading';
const percentOf = (d) => (d.status === 'done' ? 100 : d.total ? Math.floor((d.received / d.total) * 100) : 0);

// ----- Gráfico de rede -----

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

const CHART_WINDOW = 120; // segundos mostrados
// Tetos "redondos" do eixo, em bytes por segundo.
const SPEED_STEPS = [128, 256, 512].flatMap((n) => [n * 1024, n * 1024 ** 2]).concat([1, 2, 4, 8, 16, 32, 64].map((n) => n * 1024 ** 2), 1024 ** 3).sort((a, b) => a - b);

// Linhas de velocidade (download e envio) dos últimos dois minutos, num único
// eixo em bytes/s, com rótulo no fim de cada linha e leitura ao passar o ponteiro.
function drawChart() {
  const samples = (chartScope ? downloadHistory.items[chartScope] : downloadHistory.global) || [];
  const width = Math.max(320, dlChart.clientWidth);
  const height = 240;
  const box = { left: 76, right: width - 132, top: 14, bottom: height - 28 };
  const now = samples.length ? samples[samples.length - 1].t : Date.now();
  const recent = samples.filter((s) => now - s.t <= CHART_WINDOW * 1000);
  const peak = Math.max(0, ...recent.flatMap((s) => [s.down, s.up]));
  const top = SPEED_STEPS.find((step) => step >= peak) || peak;
  const x = (t) => box.right - ((now - t) / (CHART_WINDOW * 1000)) * (box.right - box.left);
  const y = (value) => box.bottom - (value / top) * (box.bottom - box.top);

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

  // Grade e eixo: discretos, com valores redondos.
  for (const fraction of [0, 0.5, 1]) {
    const lineY = y(top * fraction);
    root.append(
      svg('line', { class: 'grid', x1: box.left, x2: box.right, y1: lineY, y2: lineY }),
      svg('text', { class: 'tick', x: box.left - 10, y: lineY + 4, 'text-anchor': 'end' }, fraction ? formatSpeed(top * fraction) : '0')
    );
  }
  for (const [seconds, anchor] of [[120, 'start'], [60, 'middle'], [0, 'end']]) {
    root.append(svg('text', { class: 'tick', x: x(now - seconds * 1000), y: height - 8, 'text-anchor': anchor }, seconds ? `há ${seconds} s` : 'agora'));
  }

  if (recent.length > 1) {
    const path = (key) => recent.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join('');
    const first = x(recent[0].t).toFixed(1);
    root.append(
      svg('path', { class: 'area down', d: `${path('down')}L${box.right},${box.bottom}L${first},${box.bottom}Z` }),
      svg('path', { class: 'series up', d: path('up') }),
      svg('path', { class: 'series down', d: path('down') })
    );

    // Rótulo no fim de cada linha. Se as duas terminam juntas, os rótulos se
    // afastam e um traço fino liga cada um ao seu ponto.
    const last = recent[recent.length - 1];
    const ends = [['down', y(last.down)], ['up', y(last.up)]];
    const labels = ends.map(([key, endY]) => ({ key, endY, labelY: endY }));
    if (Math.abs(labels[0].labelY - labels[1].labelY) < 18) {
      const middle = (labels[0].labelY + labels[1].labelY) / 2;
      const [upper, lower] = labels[0].endY <= labels[1].endY ? labels : [labels[1], labels[0]];
      upper.labelY = Math.max(box.top + 4, middle - 9);
      lower.labelY = upper.labelY + 18;
    }
    for (const { key, endY, labelY } of labels) {
      if (labelY !== endY) root.append(svg('line', { class: 'leader', x1: box.right + 5, y1: endY, x2: box.right + 12, y2: labelY }));
      root.append(
        svg('circle', { class: `dot ${key}`, cx: box.right, cy: endY, r: 4 }),
        svg('text', { class: 'end-label', x: box.right + 14, y: labelY + 4 }, formatSpeed(last[key]))
      );
    }
  } else {
    root.append(svg('text', { class: 'tick', x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, 'text-anchor': 'middle' }, 'Nada baixando agora'));
  }

  // Leitura ao passar o ponteiro: uma linha vertical na amostra mais próxima
  // e uma caixa com os dois valores.
  const cross = svg('g', { class: 'cross', visibility: 'hidden' });
  const crossLine = svg('line', { class: 'crosshair', y1: box.top, y2: box.bottom });
  const crossDown = svg('circle', { class: 'dot down', r: 4 });
  const crossUp = svg('circle', { class: 'dot up', r: 4 });
  cross.append(crossLine, crossUp, crossDown);
  const hit = svg('rect', { class: 'hit', x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top });
  root.append(cross, hit);

  const tip = el('div', 'chart-tip');
  tip.hidden = true;
  const show = (fraction) => {
    chartHover = fraction;
    if (fraction === null || recent.length < 2) {
      cross.setAttribute('visibility', 'hidden');
      tip.hidden = true;
      return;
    }
    const target = now - (1 - fraction) * CHART_WINDOW * 1000;
    const sample = recent.reduce((a, b) => (Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a));
    const sx = x(sample.t);
    crossLine.setAttribute('x1', sx);
    crossLine.setAttribute('x2', sx);
    crossDown.setAttribute('cx', sx);
    crossDown.setAttribute('cy', y(sample.down));
    crossUp.setAttribute('cx', sx);
    crossUp.setAttribute('cy', y(sample.up));
    cross.setAttribute('visibility', 'visible');

    const ago = Math.round((now - sample.t) / 1000);
    const row = (key, value, label) => {
      const node = el('div', 'tip-row');
      node.append(el('span', `line-key ${key}`), el('strong', null, formatSpeed(value)), el('span', null, label));
      return node;
    };
    tip.replaceChildren(el('div', 'tip-time', ago ? `há ${ago} s` : 'agora'), row('down', sample.down, 'Download'), row('up', sample.up, 'Envio'));
    tip.hidden = false;
    // A caixa fica do lado em que há espaço.
    const toRight = sx < (box.left + box.right) / 2;
    tip.style.left = toRight ? `${sx + 14}px` : '';
    tip.style.right = toRight ? '' : `${width - sx + 14}px`;
  };
  hit.addEventListener('pointermove', (event) => {
    const bounds = hit.getBoundingClientRect();
    show(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)));
  });
  hit.addEventListener('pointerleave', () => show(null));

  dlChart.replaceChildren(root, tip);
  if (chartHover !== null) show(chartHover);

  // Mesmos dados em tabela, em médias de 10 segundos.
  const rows = [];
  for (let from = CHART_WINDOW - 10; from >= 0; from -= 10) {
    const bucket = recent.filter((s) => now - s.t >= from * 1000 && now - s.t < (from + 10) * 1000);
    if (!bucket.length) continue;
    const mean = (key) => bucket.reduce((sum, s) => sum + s[key], 0) / bucket.length;
    const tr = el('tr');
    tr.append(el('td', null, from ? `há ${from + 10}–${from} s` : 'últimos 10 s'), el('td', null, formatSpeed(mean('down'))), el('td', null, formatSpeed(mean('up'))));
    rows.push(tr);
  }
  document.querySelector('#dl-table tbody').replaceChildren(...rows);
}

// ----- Fila -----

function downloadActions(d) {
  const actions = [];
  const act = (label, iconName, run) => {
    const node = button('', iconName, (event) => {
      event.stopPropagation();
      run();
    }, 'icon-btn');
    node.title = label;
    actions.push(node);
  };
  if (d.canChoose) act('Escolher os arquivos a baixar', 'list', () => openFiles(d.id));
  if (isActive(d)) act('Pausar', 'pause', () => window.launcher.pauseDownload(d.id));
  if (d.status === 'paused' || d.status === 'error') act('Continuar', 'play', () => window.launcher.resumeDownload(d.id));
  if (d.status === 'done') {
    act('Adicionar à biblioteca', 'plus', async () => {
      if (await window.launcher.addDownloadToLibrary(d.id)) {
        showToast('Jogo adicionado à biblioteca');
        load();
      }
    });
  }
  act('Abrir pasta', 'folder-open', () => window.launcher.openDownloadFolder(d.id));
  act('Tirar da fila (os arquivos ficam no disco)', 'x', () => window.launcher.removeDownload(d.id));
  return actions;
}

// Cria a linha de um download; os campos ficam guardados para atualização no lugar.
function createDownloadRow(d) {
  const row = el('article', 'dl-item');
  const name = el('h4', 'dl-name');
  const mode = el('span', 'dl-mode');
  const actions = el('div', 'dl-actions');
  const head = el('div', 'dl-head');
  head.append(name, mode, actions);
  head.title = 'Clique para ver só este download no gráfico';
  head.addEventListener('click', () => {
    chartScope = chartScope === d.id ? null : d.id;
    renderDownloads();
  });

  const percent = el('data', 'dl-percent');
  const bar = el('progress');
  const progress = el('div', 'dl-progress');
  progress.append(bar, percent);

  const note = el('p', 'dl-note');
  const facts = el('dl', 'dl-facts');
  const cells = {};
  for (const [key, label] of [['status', 'Situação'], ['size', 'Baixado'], ['down', 'Download'], ['up', 'Envio'], ['peers', 'Pares'], ['eta', 'Tempo restante'], ['dir', 'Pasta'], ['added', 'Adicionado']]) {
    cells[key] = el('dd');
    const cell = el('div', `fact fact-${key}`);
    cell.append(el('dt', null, label), cells[key]);
    facts.append(cell);
  }

  const contents = el('details', 'dl-contents');
  const summary = el('summary');
  const files = el('ul');
  contents.append(summary, files);

  row.append(head, progress, note, facts, contents);
  return { row, name, mode, actions, percent, bar, note, cells, contents, summary, files, status: null };
}

function updateDownloadRow(parts, d) {
  parts.row.dataset.status = d.status;
  parts.row.classList.toggle('selected', chartScope === d.id);
  parts.name.textContent = d.name;
  parts.name.title = d.name;
  parts.mode.textContent = MODE_NAMES[d.mode];
  parts.percent.textContent = `${percentOf(d)}%`;
  parts.bar.max = d.total || 1;
  parts.bar.value = d.status === 'done' ? d.total || 1 : d.received;

  const message = d.status === 'error' ? d.error : d.status === 'choosing' ? 'Escolha quais arquivos deste torrent baixar (botão de lista ao lado).' : d.status === 'preparing' ? d.note || (d.mode === 'torrent' ? 'Buscando os dados do torrent...' : 'Preparando...') : '';
  parts.note.textContent = message;
  parts.note.hidden = !message;

  const { cells } = parts;
  cells.status.textContent = STATUS_NAMES[d.status];
  cells.size.textContent = d.total ? `${formatBytes(d.received)} de ${formatBytes(d.total)}` : formatBytes(d.received);
  cells.down.textContent = isActive(d) ? formatSpeed(d.speed) : '—';
  cells.up.textContent = d.mode === 'torrent' && isActive(d) ? formatSpeed(d.upSpeed || 0) : '—';
  cells.up.title = d.mode === 'torrent' ? `${formatBytes(d.uploaded || 0)} enviados no total` : '';
  cells.peers.textContent = d.mode === 'torrent' && isActive(d) ? String(d.peers) : '—';
  cells.eta.textContent = d.status === 'downloading' && d.speed ? formatEta((d.total - d.received) / d.speed) : '—';
  cells.dir.textContent = d.path || d.dir;
  cells.dir.title = d.path || d.dir;
  cells.added.textContent = new Date(d.addedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  // Arquivos do torrent, com o progresso de cada um.
  const list = d.contents || [];
  parts.contents.hidden = list.length < 2;
  parts.summary.textContent = `${list.length} arquivos`;
  if (parts.contents.open) {
    parts.files.replaceChildren(...list.map((file) => {
      // Arquivo deixado de fora da escolha: aparece riscado.
      const item = el('li', file.wanted === false && d.status !== 'choosing' ? 'skipped' : null);
      item.append(el('span', 'file-name', file.name), el('span', null, formatBytes(file.size)), el('span', null, `${Math.floor(file.progress * 100)}%`));
      return item;
    }));
  }

  // Os botões só são refeitos quando a situação muda, para não sumirem debaixo do clique.
  const state = `${d.status}|${d.canChoose}`;
  if (parts.status !== state) {
    parts.status = state;
    parts.actions.replaceChildren(...downloadActions(d));
  }
}

function renderDownloads() {
  const active = downloadItems.filter(isActive);
  const badge = document.getElementById('dl-badge');
  // Só mexe no selo quando o número muda: escrever nele a cada segundo fazia a
  // biblioteca inteira ser redesenhada, e as capas piscavam durante um download.
  if (badge.textContent !== String(active.length)) badge.textContent = String(active.length);
  badge.hidden = !active.length;
  if (downloadsScreen.hidden) return;

  const sum = (key) => active.reduce((total, d) => total + (d[key] || 0), 0);
  const stats = [
    ['Ativos', pad(active.length)],
    ['Download', formatSpeed(sum('speed'))],
    ['Envio', formatSpeed(sum('upSpeed'))],
    ['Concluídos', pad(downloadItems.filter((d) => d.status === 'done').length)],
  ];
  document.getElementById('dl-telemetry').replaceChildren(...stats.flatMap(([label, value]) => [el('dt', null, label), el('dd', null, value)]));
  // A fila tem duas partes: o que ainda falta baixar (inclusive pausados e com erro) e o que já terminou.
  const done = downloadItems.filter((d) => d.status === 'done');
  const pending = downloadItems.filter((d) => d.status !== 'done');
  const countOf = (list) => `${pad(list.length)} ${list.length === 1 ? 'item' : 'itens'}`;
  document.getElementById('dl-queue-count').textContent = countOf(pending);
  document.getElementById('dl-done-count').textContent = countOf(done);
  document.getElementById('dl-done').hidden = !done.length;

  // Gráfico: todos somados ou só o download escolhido na fila.
  if (chartScope && !downloadItems.some((d) => d.id === chartScope)) chartScope = null;
  const scoped = downloadItems.find((d) => d.id === chartScope);
  const scope = document.getElementById('dl-scope');
  scope.replaceChildren(scoped ? `Só: ${scoped.name}` : 'Todos os downloads somados');
  if (scoped) {
    scope.append(button('Ver todos', 'x', () => {
      chartScope = null;
      renderDownloads();
    }, 'scope-clear'));
  }
  drawChart();

  for (const [id, parts] of dlRows) {
    if (!downloadItems.some((d) => d.id === id)) {
      parts.row.remove();
      dlRows.delete(id);
    }
  }
  dlList.querySelector('.dl-empty')?.remove();
  // Ao terminar, a linha do download muda de lista sem ser refeita.
  const place = (container, list) => list.forEach((d, index) => {
    if (!dlRows.has(d.id)) dlRows.set(d.id, createDownloadRow(d));
    const parts = dlRows.get(d.id);
    if (container.children[index] !== parts.row) container.insertBefore(parts.row, container.children[index] || null);
    updateDownloadRow(parts, d);
  });
  place(dlList, pending);
  place(dlDoneList, done);
  if (!pending.length) {
    const emptyState = el('div', 'dl-empty');
    emptyState.append(el('h2', null, 'Nada em andamento'), el('p', null, 'Cole um link magnet ou uma URL, abra um arquivo .torrent ou busque nas fontes.'));
    dlList.append(emptyState);
  }
}

// Alterna entre a biblioteca e a tela de downloads.
async function showDownloads(visible) {
  if (visible) showStats(false);
  downloadsScreen.hidden = !visible;
  document.getElementById('layout').hidden = visible;
  document.getElementById('open-downloads').setAttribute('aria-pressed', String(visible));
  if (!visible) return;
  window.scrollTo(0, 0);
  const info = await window.launcher.getSettings();
  dlRd.hidden = !info.hasRdToken;
  // Com token ativo, o Real-Debrid é o padrão.
  dlRd.setAttribute('aria-checked', String(info.hasRdToken && useRd !== false));
  document.getElementById('dl-dir').textContent = `Salvando em ${info.downloadDir}`;
  dlError.hidden = true;
  loadSources();
  [downloadItems, downloadHistory] = await Promise.all([window.launcher.downloads(), window.launcher.downloadHistory()]);
  renderDownloads();
}

const wantsRd = () => !dlRd.hidden && dlRd.getAttribute('aria-checked') === 'true';

function showDownloadResult(result) {
  dlError.hidden = result.ok || !result.error;
  if (result.error) dlError.textContent = result.error;
}

document.getElementById('open-downloads').addEventListener('click', () => showDownloads(downloadsScreen.hidden));
document.getElementById('dl-back').addEventListener('click', () => showDownloads(false));
dlRd.addEventListener('click', () => {
  useRd = !wantsRd();
  dlRd.setAttribute('aria-checked', String(useRd));
});
document.getElementById('dl-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!dlInput.value.trim()) return;
  const result = await window.launcher.addDownload(dlInput.value, wantsRd());
  if (result.ok) dlInput.value = '';
  showDownloadResult(result);
});
document.getElementById('dl-torrent').addEventListener('click', async () => {
  showDownloadResult(await window.launcher.addTorrentFile(wantsRd()));
});
window.addEventListener('resize', () => {
  if (!downloadsScreen.hidden) drawChart();
});

// ----- Saves -----

const backupsDialog = document.getElementById('backups');
let backupsFor = null; // jogo do diálogo aberto

async function renderBackups() {
  const game = backupsFor;
  const where = document.getElementById('bk-where');
  document.getElementById('bk-name').textContent = game.name;
  setState(where, false, 'Procurando os saves...');
  const info = await window.launcher.savesInfo(game.id);
  if (backupsFor !== game) return;
  if (!info) return;
  const text = info.error
    ? info.error
    : info.paths.length
      ? `${info.custom ? 'Pasta escolhida à mão' : `Pelo catálogo (${info.title})`}:\n${info.paths.join('\n')}`
      : info.from ? 'Está no catálogo, mas os saves ainda não existem neste computador.' : 'Este jogo não está no catálogo. Escolha a pasta dos saves dele.';
  setState(where, info.paths.length > 0, text);
  document.getElementById('bk-auto').hidden = !info.custom;
  document.getElementById('bk-now').disabled = !info.paths.length;
  document.getElementById('bk-list').replaceChildren(...info.backups.map((backup) => {
    const row = el('div', 'bk-row');
    const label = el('span');
    label.append(el('strong', null, new Date(backup.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })), ` · ${backup.reason} · ${backup.files} ${backup.files === 1 ? 'arquivo' : 'arquivos'} · ${formatBytes(backup.bytes)}`);
    // Restaurar sobrescreve os saves atuais: pede um segundo clique.
    const restore = button('Restaurar', 'archive-restore', async () => {
      if (!restore.classList.contains('confirming')) {
        restore.classList.add('confirming');
        restore.lastChild.textContent = 'Confirmar';
        setTimeout(() => {
          restore.classList.remove('confirming');
          restore.lastChild.textContent = 'Restaurar';
        }, 4000);
        return;
      }
      const result = await window.launcher.restoreSaves(game.id, backup.dir);
      showToast(result.error || result.message);
      if (result.ok) renderBackups();
    });
    row.append(label, restore);
    return row;
  }));
}

function openBackups(game) {
  backupsFor = game;
  document.getElementById('bk-list').replaceChildren();
  if (!backupsDialog.open) backupsDialog.showModal();
  renderBackups();
}

document.getElementById('bk-now').addEventListener('click', async (event) => {
  const node = event.currentTarget;
  node.classList.add('spinning');
  const result = await window.launcher.backupSaves(backupsFor.id);
  node.classList.remove('spinning');
  showToast(result.error || result.message);
  renderBackups();
});
document.getElementById('bk-pick').addEventListener('click', async () => {
  if (await window.launcher.pickSavesFolder(backupsFor.id, false)) renderBackups();
});
document.getElementById('bk-auto').addEventListener('click', async () => {
  if (await window.launcher.pickSavesFolder(backupsFor.id, true)) renderBackups();
});
document.getElementById('bk-open').addEventListener('click', () => window.launcher.openSavesFolder(backupsFor.id));
document.getElementById('bk-close').addEventListener('click', () => backupsDialog.close());

// ----- Arquivos do torrent -----

const filesDialog = document.getElementById('files');
const filesList = document.getElementById('files-list');
let filesFor = null; // { id, files: [{ name, size, wanted }] } do diálogo aberto

function updateFilesSummary() {
  const picked = filesFor.files.filter((file) => file.wanted);
  const size = picked.reduce((sum, file) => sum + file.size, 0);
  document.getElementById('files-summary').textContent = `${picked.length} de ${filesFor.files.length} arquivos · ${formatBytes(size)}`;
  document.getElementById('files-save').disabled = !picked.length;
}

function renderFiles() {
  filesList.replaceChildren(...filesFor.files.map((file) => {
    const row = el('button', 'file-pick');
    row.type = 'button';
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', String(file.wanted));
    const box = el('span', 'dd-box');
    box.append(icon('check'));
    row.append(box, el('span', 'file-pick-name', file.name), el('span', 'file-pick-size', formatBytes(file.size)));
    row.addEventListener('click', () => {
      file.wanted = !file.wanted;
      row.setAttribute('aria-checked', String(file.wanted));
      updateFilesSummary();
    });
    return row;
  }));
  updateFilesSummary();
}

async function openFiles(id) {
  const info = await window.launcher.downloadFiles(id);
  if (!info || !info.canChoose) return;
  filesFor = { id, files: info.files };
  document.getElementById('files-name').textContent = info.name;
  renderFiles();
  if (!filesDialog.open) filesDialog.showModal();
}

for (const [button, wanted] of [['files-all', true], ['files-none', false]]) {
  document.getElementById(button).addEventListener('click', () => {
    for (const file of filesFor.files) file.wanted = wanted;
    renderFiles();
  });
}
document.getElementById('files-close').addEventListener('click', () => filesDialog.close());
document.getElementById('files-save').addEventListener('click', async () => {
  const indexes = filesFor.files.map((file, index) => (file.wanted ? index : -1)).filter((index) => index >= 0);
  const ok = await window.launcher.selectDownloadFiles(filesFor.id, indexes);
  filesDialog.close();
  if (!ok) showToast('Não deu para mudar os arquivos deste download.');
});

// ----- Fontes -----

const sourcesDialog = document.getElementById('sources');
const srcList = document.getElementById('src-list');
const srcUrl = document.getElementById('src-url');
const srcError = document.getElementById('src-error');
const srcBox = document.getElementById('src-box');
const srcSearch = document.getElementById('src-search');
const srcPanel = document.getElementById('src-panel');
const srcResults = document.getElementById('src-results');
let sourceItems = [];
let searchTimer = null;
// Fontes marcadas no filtro da busca (ids); vazio = todas.
let sourceFilter = [];
try {
  sourceFilter = JSON.parse(localStorage.getItem('sourceFilter')) || [];
} catch {
  // Sem filtro salvo.
}
const sourceDropdown = createDropdown('src-filter', {
  title: 'Fontes da busca',
  multiple: true,
  options: () => sourceItems.map((source) => ({ value: source.id, label: source.name, count: source.count })),
  selected: () => sourceFilter,
  onChange: (value) => {
    sourceFilter = value;
    localStorage.setItem('sourceFilter', JSON.stringify(value));
    sourceDropdown.update();
    if (!srcPanel.hidden) searchSources();
  },
});

function showSourceResult(result) {
  srcError.hidden = result.ok || !result.error;
  if (result.error) srcError.textContent = result.error;
}

function renderSources() {
  const total = sourceItems.reduce((sum, source) => sum + source.count, 0);
  document.getElementById('src-count').textContent = sourceItems.length
    ? `${sourceItems.length} ${sourceItems.length === 1 ? 'fonte' : 'fontes'} · ${total.toLocaleString('pt-BR')} itens`
    : 'Nenhuma fonte adicionada';
  srcList.replaceChildren(...sourceItems.map((source) => {
    const row = el('div', source.error ? 'account failed' : 'account');
    const when = new Date(source.fetchedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const items = `${source.count.toLocaleString('pt-BR')} itens`;
    // Sem o arquivo original, a fonte segue com a cópia que o launcher guardou.
    const status = el('span', 'account-status', source.error || (source.detached ? `${items} · cópia salva no launcher (o arquivo original não existe mais)` : `${items} · lida em ${when}`));
    const name = el('strong', null, source.name);
    name.title = source.origin;
    const refresh = button('', 'refresh-cw', async () => {
      refresh.classList.add('spinning');
      showSourceResult(await window.launcher.refreshSource(source.id));
      loadSources();
    }, 'icon-btn');
    refresh.title = 'Ler a fonte de novo';
    const remove = button('', 'trash-2', async () => {
      await window.launcher.removeSource(source.id);
      loadSources();
    }, 'icon-btn');
    remove.title = 'Remover a fonte (os downloads já feitos ficam)';
    row.append(name, status, refresh, remove);
    return row;
  }));
  // O filtro só faz sentido com mais de uma fonte; fonte removida sai dele.
  sourceFilter = sourceFilter.filter((id) => sourceItems.some((source) => source.id === id));
  sourceDropdown.root.hidden = sourceItems.length < 2;
  if (sourceItems.length < 2) sourceFilter = [];
  sourceDropdown.update();
  // Sem fonte não há onde buscar.
  srcSearch.disabled = !sourceItems.length;
  srcSearch.placeholder = sourceItems.length ? 'Buscar nas fontes' : 'Adicione uma fonte para buscar';
  if (!sourceItems.length) srcPanel.hidden = true;
}

// Preenche o painel de resultados; clicar num deles põe o item na fila.
async function searchSources() {
  if (!sourceItems.length) return;
  const term = srcSearch.value;
  const only = sourceFilter;
  const found = await window.launcher.searchSources(term, only);
  if (term !== srcSearch.value || only !== sourceFilter) return; // resposta de uma busca que já foi trocada
  const shown = found.items.length;
  document.getElementById('src-summary').textContent = !found.total
    ? 'Nada encontrado'
    : shown < found.total ? `${shown} de ${found.total.toLocaleString('pt-BR')} itens · refine a busca` : `${shown} ${shown === 1 ? 'item' : 'itens'}`;
  srcResults.replaceChildren(...found.items.map((item) => {
    const row = button('', null, async () => {
      srcPanel.hidden = true;
      const result = await window.launcher.downloadFromSource(item, wantsRd());
      showDownloadResult(result);
      if (result.ok) showToast(`Na fila: ${item.title}`);
    }, 'src-item');
    row.title = `Baixar: ${item.title}`;
    const meta = [item.sourceName, item.size, item.date && new Date(item.date).toLocaleDateString('pt-BR')].filter(Boolean).join(' · ');
    row.append(el('span', 'src-title', item.title), el('span', 'src-meta', meta));
    return row;
  }));
}

async function loadSources() {
  sourceItems = await window.launcher.sources();
  renderSources();
  if (!srcPanel.hidden) searchSources();
}

function openSourcePanel() {
  if (!sourceItems.length || !srcPanel.hidden) return;
  srcPanel.hidden = false;
  searchSources();
}

srcSearch.addEventListener('focus', openSourcePanel);
srcSearch.addEventListener('click', openSourcePanel);
srcSearch.addEventListener('input', () => {
  openSourcePanel();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchSources, 200);
});
document.addEventListener('click', (event) => {
  // Mexer no filtro de fontes não fecha os resultados: eles se atualizam por trás.
  const path = event.composedPath();
  if (!path.includes(srcBox) && !path.includes(sourceDropdown.root)) srcPanel.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') srcPanel.hidden = true;
});

async function openSources() {
  srcError.hidden = true;
  await loadSources();
  sourcesDialog.showModal();
}
document.getElementById('src-open').addEventListener('click', openSources);
document.getElementById('set-sources-open').addEventListener('click', openSources);
// Fechou o diálogo das fontes por cima das configurações: atualiza a contagem de lá.
sourcesDialog.addEventListener('close', () => { if (settings.open) showSettingsStatus(); });
document.getElementById('src-close').addEventListener('click', () => sourcesDialog.close());
document.getElementById('src-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!srcUrl.value.trim()) return;
  srcError.hidden = false;
  srcError.textContent = 'Lendo a fonte...';
  const result = await window.launcher.addSourceUrl(srcUrl.value);
  if (result.ok) srcUrl.value = '';
  showSourceResult(result);
  loadSources();
});
document.getElementById('src-file').addEventListener('click', async () => {
  showSourceResult(await window.launcher.addSourceFile());
  loadSources();
});
window.launcher.onSources(() => {
  if (!downloadsScreen.hidden) loadSources();
});
window.launcher.onDownloads((list, history) => {
  // Avisa quando um download termina, mesmo fora da tela de downloads.
  for (const d of list) {
    const before = downloadItems.find((old) => old.id === d.id);
    if (d.status === 'done' && before && before.status !== 'done') showToast(`Download concluído: ${d.name}`);
    // Torrent com vários arquivos: os dados chegaram e ele espera a escolha.
    if (d.status === 'choosing' && (!before || before.status !== 'choosing')) {
      if (!downloadsScreen.hidden && !document.querySelector('dialog[open]')) openFiles(d.id);
      else showToast(`Escolha os arquivos de: ${d.name}`);
    }
  }
  downloadItems = list;
  if (history) downloadHistory = history;
  renderDownloads();
});
window.launcher.downloads().then((list) => {
  downloadItems = list;
  renderDownloads();
});

document.getElementById('dl-dir-pick').addEventListener('click', async () => {
  if (await window.launcher.pickDownloadDir()) showSettingsStatus();
});
const rdToken = document.getElementById('rd-token');
const saveRdToken = (token) => saveKey(rdToken, document.getElementById('rd-status'), window.launcher.setRdToken, token);
document.getElementById('rd-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (rdToken.value.trim()) saveRdToken(rdToken.value);
});
document.getElementById('rd-clear').addEventListener('click', () => saveRdToken(''));
document.getElementById('rd-open').addEventListener('click', () => window.launcher.openRdTokenPage());

const STORES = [
  { id: 'gog', name: 'GOG', login: true },
  { id: 'epic', name: 'Epic Games', login: true },
  { id: 'ubisoft', name: 'Ubisoft Connect' },
  { id: 'ea', name: 'EA App' },
];

// Linhas de "Outras lojas": situação de cada uma e, onde há login, o botão.
// `message` troca o texto de uma loja (ex.: aguardando login, erro).
function renderAccounts(status, message = {}) {
  document.getElementById('accounts').replaceChildren(...STORES.map((store) => {
    const info = status[store.id] || {};
    const row = el('div', 'account');
    let text;
    if (message[store.id]) text = message[store.id];
    else if (!store.login) text = info.count ? `${info.count} jogos achados neste PC` : 'Nenhum jogo achado neste PC';
    else if (!info.connected) text = 'Não conectada';
    else if (info.expired) text = 'Sessão expirada · conecte de novo';
    else text = `Conectada · ${info.count ?? 0} jogos na conta`;
    row.append(el('strong', null, store.name), el('span', 'account-status', text));
    if (store.login && info.connected && !info.expired) {
      row.append(button('Desconectar', 'log-out', async () => {
        await window.launcher.disconnectAccount(store.id);
        showSettingsStatus();
      }));
    } else if (store.login) {
      row.append(button('Conectar', 'log-in', async () => {
        renderAccounts(status, { [store.id]: 'Aguardando o login na janela da loja...' });
        const result = await window.launcher.connectAccount(store.id);
        const fresh = (await window.launcher.getSettings()).accounts;
        renderAccounts(fresh, result.ok ? {} : { [store.id]: result.error });
      }));
    }
    return row;
  }));
}

async function saveKey(input, status, save, key) {
  setState(status, false, 'Verificando...');
  const result = await save(key);
  input.value = '';
  if (result.ok) await showSettingsStatus();
  else setState(status, false, result.error);
}

const saveSteamKey = (key) => saveKey(steamKey, steamStatus, window.launcher.setSteamKey, key);
const saveSgdbKey = (key) => saveKey(sgdbKey, sgdbStatus, window.launcher.setSgdbKey, key);

document.getElementById('open-settings').addEventListener('click', () => {
  showSettingsStatus();
  settings.showModal();
});
document.getElementById('steam-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (steamKey.value.trim()) saveSteamKey(steamKey.value);
});
document.getElementById('steam-clear').addEventListener('click', () => saveSteamKey(''));
document.getElementById('steam-open').addEventListener('click', () => window.launcher.openSteamKeyPage());
document.getElementById('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (sgdbKey.value.trim()) saveSgdbKey(sgdbKey.value);
});
document.getElementById('sgdb-clear').addEventListener('click', () => saveSgdbKey(''));
document.getElementById('sgdb-open').addEventListener('click', () => window.launcher.openSgdbKeyPage());
document.getElementById('settings-close').addEventListener('click', () => settings.close());

// ---------- Modo tela grande ----------
// Capas grandes numa fileira, em tela cheia, para jogar do sofá. Navega com o
// controle (Gamepad API), o teclado ou o mouse. O controle só é lido enquanto há
// um conectado, e a tela só é redesenhada quando a seleção muda.

const big = document.getElementById('big');
const bigRow = document.getElementById('big-row');
let bigGames = [];
let bigIndex = 0;

// Instalados primeiro, os jogados mais recentemente na frente; depois o resto pelo nome.
function bigList() {
  return shownGames().slice().sort((a, b) => (b.installed - a.installed) || (b.lastPlayed - a.lastPlayed) || byName(a, b));
}

function renderBig() {
  const keep = bigGames[bigIndex] && bigGames[bigIndex].id;
  bigGames = bigList();
  bigIndex = Math.max(0, bigGames.findIndex((g) => g.id === keep));
  bigRow.replaceChildren(...bigGames.map((game, index) => {
    const card = el('div', game.installed ? 'big-card' : 'big-card missing');
    if (game.covers.length) {
      const queue = [...game.covers];
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        if (queue.length) img.src = queue.shift();
        else img.replaceWith(el('div', 'big-fallback', game.name));
      };
      img.src = queue.shift();
      card.append(img);
    } else {
      card.append(el('div', 'big-fallback', game.name));
    }
    if (game.runningSince) card.append(el('span', 'big-live', 'Em execução'));
    card.addEventListener('click', () => selectBig(index));
    card.addEventListener('dblclick', () => launch(game));
    return card;
  }));
  selectBig(bigIndex, true);
  const running = games.filter((g) => g.runningSince).map((g) => g.name).join(' · ');
  document.getElementById('big-playing').textContent = running ? `Jogando ${running}` : '';
}

function selectBig(index, instant) {
  if (!bigGames.length) return;
  bigIndex = Math.max(0, Math.min(bigGames.length - 1, index));
  const game = bigGames[bigIndex];
  [...bigRow.children].forEach((card, i) => card.classList.toggle('on', i === bigIndex));
  const card = bigRow.children[bigIndex];
  // Mantém a capa escolhida a um terço da largura, rolando a fileira.
  bigRow.scrollTo({ left: Math.max(0, card.offsetLeft - bigRow.clientWidth / 3), behavior: instant ? 'auto' : 'smooth' });
  document.getElementById('big-name').textContent = game.name;
  document.getElementById('big-source').textContent = `[ ${game.source} ]${game.installed ? '' : ' // não instalado'}`;
  const facts = [['Jogado', formatPlaytime(game.playtimeMinutes)], ['Última vez', formatDate(game.lastPlayed) || 'Nunca'], ...(game.sizeBytes ? [['No disco', formatBytes(game.sizeBytes)]] : [])];
  document.getElementById('big-facts').replaceChildren(...facts.map(([label, value]) => {
    const node = el('div');
    node.append(el('span', null, label), value);
    return node;
  }));
  const art = game.heroes[0] || game.covers[0];
  document.getElementById('big-backdrop').style.backgroundImage = art ? `url("${art}")` : 'none';
  // Cor do jogo na moldura da capa escolhida.
  const color = accents.has(game.id) ? accents.get(game.id) : game.accent;
  if (color) bigRow.style.setProperty('--game', color);
  else {
    bigRow.style.removeProperty('--game');
    if (!accents.has(game.id)) {
      accents.set(game.id, null);
      window.launcher.accent(game.id).then((found) => {
        accents.set(game.id, found);
        if (found && bigGames[bigIndex] === game) bigRow.style.setProperty('--game', found);
      });
    }
  }
}

function updateBigClock() {
  document.getElementById('big-clock').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
let bigClockTimer = null;

function openBig(open) {
  if (open === !big.hidden) return;
  big.hidden = !open;
  window.launcher.setFullScreen(open);
  if (open) {
    closeGameMenu();
    renderBig();
    updateBigClock();
    bigClockTimer = setInterval(updateBigClock, 30000);
  } else {
    clearInterval(bigClockTimer);
  }
}

function bigPress(action) {
  if (big.hidden) return;
  const game = bigGames[bigIndex];
  if (action === 'left') selectBig(bigIndex - 1);
  else if (action === 'right') selectBig(bigIndex + 1);
  else if (action === 'pageLeft') selectBig(bigIndex - 6);
  else if (action === 'pageRight') selectBig(bigIndex + 6);
  else if (action === 'launch' && game) {
    if (game.runningSince) showToast(`${game.name} está aberto`);
    else launch(game);
  } else if (action === 'back') openBig(false);
}

document.getElementById('open-big').addEventListener('click', () => openBig(true));
document.addEventListener('keydown', (event) => {
  if (big.hidden) return;
  const keys = { ArrowLeft: 'left', ArrowUp: 'left', ArrowRight: 'right', ArrowDown: 'right', PageUp: 'pageLeft', PageDown: 'pageRight', Enter: 'launch', Escape: 'back', Backspace: 'back' };
  if (!keys[event.key]) return;
  event.preventDefault();
  event.stopPropagation();
  bigPress(keys[event.key]);
}, true);
bigRow.addEventListener('wheel', (event) => {
  event.preventDefault();
  bigPress(event.deltaY + event.deltaX > 0 ? 'right' : 'left');
}, { passive: false });

// ----- Controle -----
// Botões do mapeamento padrão: 0 A, 1 B, 4 LB, 5 RB, 9 Start, 12-15 direcional.
// Segurar repete (primeiro depois de 350 ms, depois a cada 110 ms).
const PAD_BUTTONS = { 0: 'launch', 1: 'back', 4: 'pageLeft', 5: 'pageRight', 14: 'left', 15: 'right', 12: 'left', 13: 'right' };
let padTimer = null;
const padHeld = new Map(); // ação -> { since, last }
function pollPads() {
  const pads = [...navigator.getGamepads()].filter(Boolean);
  if (!pads.length) return;
  const now = performance.now();
  const pressed = new Set();
  let start = false;
  for (const pad of pads) {
    pad.buttons.forEach((b, i) => {
      if (!b.pressed) return;
      if (i === 9) start = true;
      else if (PAD_BUTTONS[i]) pressed.add(PAD_BUTTONS[i]);
    });
    const [x = 0, y = 0] = pad.axes;
    if (x < -0.5 || y < -0.5) pressed.add('left');
    if (x > 0.5 || y > 0.5) pressed.add('right');
  }
  if (start) pressed.add('start');
  for (const action of [...padHeld.keys()]) if (!pressed.has(action)) padHeld.delete(action);
  for (const action of pressed) {
    const held = padHeld.get(action);
    const repeats = ['left', 'right', 'pageLeft', 'pageRight'].includes(action);
    if (!held) {
      padHeld.set(action, { since: now, last: now });
      if (action === 'start') openBig(big.hidden);
      else bigPress(action);
    } else if (repeats && now - held.since > 350 && now - held.last > 110) {
      held.last = now;
      bigPress(action);
    }
  }
}
function watchPads() {
  const any = [...navigator.getGamepads()].some(Boolean);
  if (any && !padTimer) padTimer = setInterval(pollPads, 50);
  if (!any && padTimer) {
    clearInterval(padTimer);
    padTimer = null;
  }
}
window.addEventListener('gamepadconnected', watchPads);
window.addEventListener('gamepaddisconnected', watchPads);

// ---------- Estatísticas ----------

const statsScreen = document.getElementById('stats-screen');
let statsSessions = [];
let statsHover = null; // índice do dia sob o ponteiro, mantido entre redesenhos

// Dia local no formato AAAA-MM-DD.
const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const formatHours = (seconds) => (seconds / 3600).toLocaleString('pt-BR', { maximumFractionDigits: seconds < 36000 ? 1 : 0 });

// Segundos jogados por dia (e por jogo em cada dia). Sessão que passa da meia-noite é dividida entre os dias.
function secondsByDay(sessions) {
  const days = new Map();
  for (const session of sessions) {
    let start = (session.at - session.seconds) * 1000;
    const end = session.at * 1000;
    while (start < end) {
      const date = new Date(start);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const slice = (Math.min(end, midnight) - start) / 1000;
      const key = dayKey(date);
      if (!days.has(key)) days.set(key, { seconds: 0, games: new Map() });
      const day = days.get(key);
      day.seconds += slice;
      day.games.set(session.name, (day.games.get(session.name) || 0) + slice);
      start = midnight;
    }
  }
  return days;
}

function renderStats() {
  const days = secondsByDay(statsSessions);
  const today = new Date();
  const last30 = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29 + i);
    return { date, ...(days.get(dayKey(date)) || { seconds: 0, games: new Map() }) };
  });
  const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29).getTime() / 1000;
  const monthSessions = statsSessions.filter((s) => s.at >= since);
  const monthSeconds = last30.reduce((sum, d) => sum + d.seconds, 0);

  // Dias seguidos jogando, até hoje (ou até ontem, se hoje ainda não jogou).
  let streak = 0;
  for (let i = days.has(dayKey(today)) ? 0 : 1; ; i++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    if (!days.has(dayKey(date))) break;
    streak++;
  }
  const longest = monthSessions.reduce((max, s) => Math.max(max, s.seconds), 0);
  const rows = [
    ['Horas no mês', formatHours(monthSeconds)],
    ['Sessões no mês', pad(monthSessions.length)],
    ['Média por sessão', monthSessions.length ? formatPlaytime(Math.round(monthSeconds / monthSessions.length / 60)) : '—'],
    ['Maior sessão', longest ? formatPlaytime(Math.round(longest / 60)) : '—'],
    ['Dias seguidos', pad(streak)],
  ];
  document.getElementById('st-telemetry').replaceChildren(...rows.flatMap(([label, value]) => [el('dt', null, label), el('dd', null, value)]));

  drawStatsChart(last30);

  // Tabela com os mesmos números do gráfico.
  document.querySelector('#st-table tbody').replaceChildren(...last30.filter((d) => d.seconds).reverse().map((d) => {
    const tr = el('tr');
    tr.append(el('td', null, d.date.toLocaleDateString('pt-BR')), el('td', null, formatHours(d.seconds)), el('td', null, [...d.games.keys()].join(', ')));
    return tr;
  }));

  // Mais jogados: no mês (sessões do Ludex) e de sempre (tempo das lojas e do Ludex).
  const month = new Map();
  for (const d of last30) for (const [name, seconds] of d.games) month.set(name, (month.get(name) || 0) + seconds);
  rankList(document.getElementById('st-month'), [...month].map(([name, seconds]) => ({ name, seconds })), 'Nenhum jogo aberto pelo Ludex nos últimos 30 dias.');
  rankList(document.getElementById('st-ever'), games.filter((g) => g.playtimeMinutes).map((g) => ({ name: g.name, seconds: g.playtimeMinutes * 60 })), 'Nenhum tempo de jogo registrado ainda.');
}

// Lista dos 8 maiores, com barra proporcional ao primeiro.
function rankList(node, items, emptyText) {
  items.sort((a, b) => b.seconds - a.seconds);
  const top = items.slice(0, 8);
  if (!top.length) {
    node.replaceChildren(el('li', 'st-none', emptyText));
    return;
  }
  node.replaceChildren(...top.map((item) => {
    const li = el('li');
    const name = el('span', 'st-name', item.name);
    name.title = item.name;
    const track = el('span', 'st-track');
    const fill = el('span', 'st-fill');
    fill.style.width = `${Math.max(2, (item.seconds / top[0].seconds) * 100)}%`;
    track.append(fill);
    li.append(name, el('span', 'st-value', `${formatHours(item.seconds)} h`), track);
    return li;
  }));
}

// Barras por dia: um tom só (é uma série), topo arredondado, 2 px entre barras,
// grade discreta com valores redondos e leitura ao passar o ponteiro.
function drawStatsChart(last30) {
  const chart = document.getElementById('st-chart');
  const width = Math.max(320, chart.clientWidth);
  const height = 260;
  const box = { left: 52, right: width - 8, top: 12, bottom: height - 28 };
  const peak = Math.max(...last30.map((d) => d.seconds)) / 3600;
  const top = [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24].find((step) => step >= peak) || 24;
  const y = (hours) => box.bottom - (hours / top) * (box.bottom - box.top);
  const slot = (box.right - box.left) / last30.length;
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

  for (const fraction of [0, 0.5, 1]) {
    const lineY = y(top * fraction);
    root.append(
      svg('line', { class: 'grid', x1: box.left, x2: box.right, y1: lineY, y2: lineY }),
      svg('text', { class: 'tick', x: box.left - 10, y: lineY + 4, 'text-anchor': 'end' }, `${(top * fraction).toLocaleString('pt-BR')} h`)
    );
  }
  last30.forEach((d, i) => {
    if (i % 7 !== 1 && i !== last30.length - 1) return;
    const label = i === last30.length - 1 ? 'hoje' : d.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    root.append(svg('text', { class: 'tick', x: box.left + slot * (i + 0.5), y: height - 8, 'text-anchor': 'middle' }, label));
  });

  const tip = el('div', 'chart-tip');
  tip.hidden = true;
  const columns = last30.map((d, i) => {
    const col = svg('g', { class: 'col' });
    const x = box.left + slot * i + 1;
    const barWidth = Math.max(2, slot - 2);
    const barHeight = box.bottom - y(d.seconds / 3600);
    if (barHeight >= 1) {
      // Topo arredondado (4 px) e base reta, presa ao eixo.
      const r = Math.min(4, barWidth / 2, barHeight);
      const top = box.bottom - barHeight;
      col.append(svg('path', { class: 'bar', d: `M${x},${box.bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + barWidth - r}Q${x + barWidth},${top} ${x + barWidth},${top + r}V${box.bottom}Z` }));
    }
    col.append(svg('rect', { class: 'hit', x: box.left + slot * i, y: box.top, width: slot, height: box.bottom - box.top }));
    col.addEventListener('pointerenter', () => showTip(i));
    col.addEventListener('pointerleave', () => showTip(null));
    root.append(col);
    return col;
  });

  function showTip(index) {
    statsHover = index;
    columns.forEach((col, i) => col.classList.toggle('on', i === index));
    if (index === null) {
      tip.hidden = true;
      return;
    }
    const d = last30[index];
    const games = [...d.games].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const row = (text, value) => {
      const node = el('div', 'tip-row');
      node.append(el('strong', null, value), el('span', null, text));
      return node;
    };
    tip.replaceChildren(
      el('div', 'tip-time', d.date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })),
      row('no total', `${formatHours(d.seconds)} h`),
      ...games.map(([name, seconds]) => row(name, formatPlaytime(Math.max(1, Math.round(seconds / 60)))))
    );
    tip.hidden = false;
    const center = box.left + slot * (index + 0.5);
    const toRight = center < width / 2;
    tip.style.left = toRight ? `${center + 12}px` : '';
    tip.style.right = toRight ? '' : `${width - center + 12}px`;
  }

  if (!last30.some((d) => d.seconds)) {
    root.append(svg('text', { class: 'empty', x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, 'text-anchor': 'middle' }, 'Nenhuma sessão nos últimos 30 dias. Abra um jogo pelo Ludex e ela aparece aqui.'));
  }
  chart.replaceChildren(root, tip);
  if (statsHover !== null) showTip(statsHover);
}

async function showStats(visible) {
  if (visible) showDownloads(false);
  statsScreen.hidden = !visible;
  document.getElementById('layout').hidden = visible || !downloadsScreen.hidden;
  document.getElementById('open-stats').setAttribute('aria-pressed', String(visible));
  if (!visible) return;
  window.scrollTo(0, 0);
  statsSessions = await window.launcher.stats();
  renderStats();
}

document.getElementById('open-stats').addEventListener('click', () => showStats(statsScreen.hidden));
document.getElementById('st-back').addEventListener('click', () => showStats(false));
window.addEventListener('resize', () => {
  if (!statsScreen.hidden) renderStats();
});
// Uma sessão terminou (o processo principal avisa): atualiza se a tela estiver aberta.
window.launcher.onChanged(async () => {
  if (statsScreen.hidden) return;
  statsSessions = await window.launcher.stats();
  renderStats();
});

// ---------- Botões da janela ----------

const winMax = document.getElementById('win-max');
function showMaximized(maximized) {
  winMax.replaceChildren(icon(maximized ? 'copy' : 'square'));
  winMax.title = maximized ? 'Restaurar' : 'Maximizar';
}
document.getElementById('win-min').addEventListener('click', () => window.launcher.minimizeWindow());
winMax.addEventListener('click', () => window.launcher.toggleMaximizeWindow());
document.getElementById('win-close').addEventListener('click', () => window.launcher.closeWindow());
// Duplo clique na barra maximiza, como na barra de título do Windows.
document.querySelector('header').addEventListener('dblclick', (event) => {
  if (event.target === event.currentTarget) window.launcher.toggleMaximizeWindow();
});
window.launcher.onWindowMaximized(showMaximized);
window.launcher.isWindowMaximized().then(showMaximized);

// Ícones declarados no HTML como <i data-icon="nome">.
for (const placeholder of document.querySelectorAll('i[data-icon]')) {
  placeholder.replaceWith(icon(placeholder.dataset.icon));
}

// O processo principal avisa quando chegam informações novas (loja, tempo de jogo).
window.launcher.onChanged(() => load());

load(false, true);

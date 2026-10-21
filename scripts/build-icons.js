// Gera renderer/icons.js com os ícones do Lucide usados na interface.
// Para usar um ícone novo: acrescente o nome aqui e rode `npm run icons`.
const fs = require('fs');
const path = require('path');

const NAMES = [
  'activity', 'archive-restore', 'arrow-left', 'calendar', 'chart-column', 'check', 'chevron-down', 'chevron-right', 'clock', 'download', 'external-link', 'eye', 'eye-off', 'file-cog', 'file-down', 'folder', 'folder-down', 'folder-open', 'folder-plus',
  'gamepad-2', 'image', 'key-round', 'layout-grid', 'list', 'log-in', 'log-out', 'minus', 'pause', 'pencil', 'play', 'plus', 'refresh-cw', 'save', 'search',
  'settings', 'square', 'copy', 'store', 'trash-2', 'trophy', 'tv', 'user-round', 'x',
];

const source = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const icons = {};
for (const name of NAMES) {
  icons[name] = fs.readFileSync(path.join(source, `${name}.svg`), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+class="[^"]*"/, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/ >/g, '>')
    .trim();
}

fs.writeFileSync(
  path.join(__dirname, '..', 'renderer', 'icons.js'),
  `// Gerado por scripts/build-icons.js a partir do lucide-static (licença ISC). Não edite à mão.\nconst ICONS = ${JSON.stringify(icons, null, 2)};\n`
);
console.log(`${NAMES.length} ícones gerados.`);

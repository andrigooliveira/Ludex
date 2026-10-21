// Copia para renderer/fonts as fontes usadas na interface (licença OFL),
// para o app funcionar sem internet. Rode com `npm run assets`.
const fs = require('fs');
const path = require('path');

const FONTS = [
  ['@fontsource-variable/archivo', 'archivo-latin-wght-normal.woff2'],
  ['@fontsource-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'],
];

const target = path.join(__dirname, '..', 'renderer', 'fonts');
fs.mkdirSync(target, { recursive: true });
for (const [pkg, file] of FONTS) {
  fs.copyFileSync(path.join(__dirname, '..', 'node_modules', pkg, 'files', file), path.join(target, file));
}
console.log(`${FONTS.length} fontes copiadas.`);

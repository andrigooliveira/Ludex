// Monta o instalador com interface própria (dist/Ludex Setup <versão>.exe), depois
// que o electron-builder gerou o instalador NSIS. Roda em `npm run build`.
//   1. garante as DLLs do WebView2 (pacote oficial da Microsoft no NuGet, baixado uma vez para build/webview2);
//   2. embute fontes e ícone na ui.html;
//   3. compila Setup.cs com o csc do .NET Framework (já vem no Windows);
//   4. gruda o instalador NSIS no fim do executável.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
// Argumentos opcionais (para montar uma variante de teste): pasta de saída e nome do produto.
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist');
const product = process.argv[3] || pkg.productName;
const LEGACY = process.argv[3] ? [] : ['Game Launcher']; // nome antigo do app: instalação e processo reconhecidos
const work = path.join(dist, 'setup-build');
const WEBVIEW2 = '1.0.4129.50';
const webview2 = path.join(root, 'build', 'webview2', WEBVIEW2);
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const FRAMEWORK = path.dirname(CSC);

async function ensureWebView2() {
  const needed = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
  if (needed.every((name) => fs.existsSync(path.join(webview2, name)))) return;
  console.log(`Baixando o WebView2 SDK ${WEBVIEW2}...`);
  const res = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2}/microsoft.web.webview2.${WEBVIEW2}.nupkg`);
  if (!res.ok) throw new Error(`NuGet respondeu HTTP ${res.status}`);
  const unpack = path.join(work, 'webview2');
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  const zip = path.join(work, 'webview2.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpack}' -Force`]);
  fs.mkdirSync(webview2, { recursive: true });
  for (const name of needed.slice(0, 2)) fs.copyFileSync(path.join(unpack, 'lib', 'net462', name), path.join(webview2, name));
  fs.copyFileSync(path.join(unpack, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll'), path.join(webview2, 'WebView2Loader.dll'));
}

function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderSize(full) : fs.statSync(full).size;
  }
  return total;
}

(async () => {
  const nsis = path.join(dist, `ludex-nsis-${version}.exe`);
  if (!fs.existsSync(nsis)) throw new Error(`Instalador NSIS não encontrado: ${nsis}`);
  fs.mkdirSync(work, { recursive: true });
  await ensureWebView2();

  const base64 = (file) => fs.readFileSync(file).toString('base64');
  const ui = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8')
    .replace('{{ARCHIVO}}', base64(path.join(root, 'renderer', 'fonts', 'archivo-latin-wght-normal.woff2')))
    .replace('{{MONO}}', base64(path.join(root, 'renderer', 'fonts', 'jetbrains-mono-latin-wght-normal.woff2')))
    .split('{{ICON}}').join(base64(path.join(root, 'assets', 'icon.png')));
  fs.writeFileSync(path.join(work, 'ui.html'), ui);
  fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({ version, product, legacy: LEGACY, requiredBytes: folderSize(path.join(dist, 'win-unpacked')) }));

  const shell = path.join(work, 'LudexSetup.exe');
  const dll = (name) => path.join(webview2, name);
  execFileSync(CSC, [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    `/win32icon:${path.join(root, 'assets', 'icon.ico')}`,
    `/out:${shell}`,
    `/r:${dll('Microsoft.Web.WebView2.Core.dll')}`,
    `/r:${dll('Microsoft.Web.WebView2.WinForms.dll')}`,
    `/r:${path.join(FRAMEWORK, 'System.Windows.Forms.dll')}`,
    `/r:${path.join(FRAMEWORK, 'System.Drawing.dll')}`,
    `/r:${path.join(FRAMEWORK, 'System.Web.Extensions.dll')}`,
    `/resource:${path.join(work, 'ui.html')},ui.html`,
    `/resource:${path.join(work, 'config.json')},config.json`,
    `/resource:${dll('Microsoft.Web.WebView2.Core.dll')},Microsoft.Web.WebView2.Core.dll`,
    `/resource:${dll('Microsoft.Web.WebView2.WinForms.dll')},Microsoft.Web.WebView2.WinForms.dll`,
    `/resource:${dll('WebView2Loader.dll')},WebView2Loader.dll`,
    path.join(__dirname, 'Setup.cs'),
  ], { stdio: 'inherit' });

  // [casca][instalador NSIS][tamanho em 8 bytes]["LUDEXPAY"]
  const payload = fs.readFileSync(nsis);
  const trailer = Buffer.alloc(16);
  trailer.writeBigInt64LE(BigInt(payload.length), 0);
  trailer.write('LUDEXPAY', 8, 'ascii');
  const out = path.join(dist, `${product} Setup ${version}.exe`);
  fs.writeFileSync(out, Buffer.concat([fs.readFileSync(shell), payload, trailer]));
  console.log(`Instalador pronto: ${out} (${(fs.statSync(out).size / 1024 ** 2).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

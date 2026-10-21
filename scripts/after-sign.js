// Gancho do electron-builder, rodado depois de o app ser empacotado e antes de o
// instalador ser montado. Deixa a pasta de instalação organizada: tudo do
// Electron (executável real, DLLs, recursos) vai para app\, e na raiz fica só um
// executável pequeno que abre o launcher. O desinstalador é posto ao lado dele
// pelo próprio instalador.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// O antivírus às vezes segura um arquivo recém-criado por um instante.
function move(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return;
  const root = context.appOutDir;
  const inner = path.join(root, 'app');
  const exe = `${context.packager.appInfo.productFilename}.exe`;

  const entries = fs.readdirSync(root);
  fs.mkdirSync(inner);
  for (const entry of entries) move(path.join(root, entry), path.join(inner, entry));

  execFileSync(CSC, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    `/win32icon:${path.join(__dirname, '..', 'assets', 'icon.ico')}`,
    `/out:${path.join(root, exe)}`,
    path.join(__dirname, 'launcher.cs'),
  ], { stdio: 'inherit' });
};

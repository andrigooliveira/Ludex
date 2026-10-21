// Gera o ícone do app (assets/icon.ico e assets/icon.png): o controle do Lucide
// em preto sobre o vermelho de destaque, com o "_" dos títulos embaixo. Gera
// também as imagens do instalador (build/installerSidebar.bmp e installerHeader.bmp).
// Roda dentro do Electron, que é quem desenha o SVG: `npm run assets`.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const RED = '#ff2a2a';
const BLACK = '#0a0a0a';
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// O desenho do controle vem do lucide-static, o mesmo dos ícones da interface.
const gamepad = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons', 'gamepad-2.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<\/?svg[^>]*>/g, '');

// Nos tamanhos pequenos (bandeja, barra de tarefas) o traço engrossa e o
// controle ocupa o quadro todo, sem o "_", para continuar legível.
function svg(size) {
  const small = size <= 32;
  const scale = small ? 10.2 : 8.6;
  const stroke = small ? 2.6 : 2;
  const top = small ? 128 - 12 * scale : 104 - 12 * scale;
  const bar = small ? '' : `<rect x="92" y="194" width="72" height="18" fill="${BLACK}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
    <rect width="256" height="256" fill="${RED}"/>
    <g transform="translate(${128 - 12 * scale} ${top}) scale(${scale})" fill="none" stroke="${BLACK}" stroke-width="${stroke}" stroke-linecap="square" stroke-linejoin="miter">${gamepad}</g>
    ${bar}
  </svg>`;
}

// Imagem de um tamanho dentro do .ico: PNG no de 256 e bitmap de 32 bits nos
// outros, que é o que qualquer programa do Windows sabe ler.
function icoImage(png, size) {
  if (size >= 256) return png;
  const pixels = nativeImage.createFromBuffer(png).toBitmap(); // BGRA, de cima para baixo
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // imagem + máscara
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const rows = [];
  for (let y = size - 1; y >= 0; y--) rows.push(pixels.subarray(y * size * 4, (y + 1) * size * 4));
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // tudo opaco: a transparência vem do canal alfa
  return Buffer.concat([header, ...rows, mask]);
}

// Bitmap de 24 bits, o formato que o instalador (NSIS) aceita.
function bmp(png) {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  const pixels = image.toBitmap(); // BGRA, de cima para baixo
  const stride = Math.ceil((width * 3) / 4) * 4;
  const header = Buffer.alloc(54);
  header.write('BM');
  header.writeUInt32LE(54 + stride * height, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(stride * height, 34);
  const body = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.copy(body, (height - 1 - y) * stride + x * 3, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  return Buffer.concat([header, body]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  // Um canvas por tamanho: sai com os pixels exatos, sem depender da escala da tela.
  const sources = [...SIZES, 512].map((size) => ({ size, svg: svg(size) }));
  const urls = await win.webContents.executeJavaScript(`Promise.all(${JSON.stringify(sources)}.map(({ size, svg }) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('SVG inválido'));
    image.src = 'data:image/svg+xml;base64,' + btoa(svg);
  })))`);
  const pngs = urls.map((url) => Buffer.from(url.split(',')[1], 'base64'));

  const out = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(SIZES.map((size, index) => ({ size, data: icoImage(pngs[index], size) }))));
  fs.writeFileSync(path.join(out, 'icon.png'), pngs[pngs.length - 1]);

  // Imagens do instalador, com a fonte dos títulos do app: a lateral das páginas
  // de boas-vindas/conclusão (164x314) e o canto do cabeçalho das outras (150x57).
  const font = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'fonts', 'archivo-latin-wght-normal.woff2')).toString('base64');
  const installer = await win.webContents.executeJavaScript(`(async () => {
    const face = new FontFace('Archivo', 'url(data:font/woff2;base64,${font})', { weight: '100 900' });
    document.fonts.add(await face.load());
    const icon = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('SVG inválido'));
      image.src = 'data:image/svg+xml;base64,' + btoa(${JSON.stringify(svg(256))});
    });
    const canvas = (width, height, draw) => {
      const node = document.createElement('canvas');
      node.width = width;
      node.height = height;
      const ctx = node.getContext('2d');
      ctx.fillStyle = '${BLACK}';
      ctx.fillRect(0, 0, width, height);
      draw(ctx);
      return node.toDataURL('image/png');
    };
    const sidebar = canvas(164, 314, (ctx) => {
      ctx.drawImage(icon, 20, 28, 56, 56);
      ctx.font = '900 34px Archivo';
      ctx.fillStyle = '#eaeaea';
      ctx.fillText('LUDEX', 18, 262);
      ctx.fillStyle = '${RED}';
      ctx.fillRect(20, 274, 34, 6);
      ctx.fillStyle = '#242424';
      ctx.fillRect(163, 0, 1, 314); // separa a lateral do resto da página, que também é escura
    });
    const header = canvas(150, 57, (ctx) => ctx.drawImage(icon, 104, 12, 33, 33));
    return [sidebar, header];
  })()`);
  const build = path.join(__dirname, '..', 'build');
  fs.mkdirSync(build, { recursive: true });
  for (const [index, name] of ['installerSidebar.bmp', 'installerHeader.bmp'].entries()) {
    fs.writeFileSync(path.join(build, name), bmp(Buffer.from(installer[index].split(',')[1], 'base64')));
  }

  console.log(`Ícone gerado em ${SIZES.length} tamanhos, mais as imagens do instalador.`);
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});

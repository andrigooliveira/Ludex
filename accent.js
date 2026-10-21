// Cor de destaque de um jogo, tirada da capa: o matiz vivo que mais aparece,
// ajustado para ter contraste sobre o fundo escuro da interface.

function toHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function toHex(h, s, l) {
  const channel = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// `bitmap` são pixels BGRA (o formato de nativeImage.toBitmap). Devolve "#rrggbb",
// ou null quando a capa é praticamente sem cor (preto e branco, sépia apagado).
function dominantColor(bitmap) {
  const BINS = 24;
  const bins = Array.from({ length: BINS }, () => ({ weight: 0, x: 0, y: 0, s: 0 }));
  let total = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const [h, s, l] = toHsl(bitmap[i + 2], bitmap[i + 1], bitmap[i]);
    total++;
    // Ignora o que não tem cor de verdade: cinzas, quase preto, quase branco.
    if (s < 0.3 || l < 0.15 || l > 0.9) continue;
    const weight = s * (1 - Math.abs(l - 0.5));
    const bin = bins[Math.floor(h * BINS) % BINS];
    bin.weight += weight;
    // Média circular do matiz dentro da faixa.
    bin.x += Math.cos(h * 2 * Math.PI) * weight;
    bin.y += Math.sin(h * 2 * Math.PI) * weight;
    bin.s += s * weight;
  }
  const best = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (!total || best.weight / total < 0.01) return null;

  const hue = (Math.atan2(best.y, best.x) / (2 * Math.PI) + 1) % 1;
  const saturation = Math.max(0.6, Math.min(0.95, best.s / best.weight));
  // Azuis e roxos precisam ser mais claros para ler bem sobre preto.
  const lightness = hue > 0.55 && hue < 0.85 ? 0.68 : 0.58;
  return toHex(hue, saturation, lightness);
}

module.exports = { dominantColor };

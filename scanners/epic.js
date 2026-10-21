const fs = require('fs');
const path = require('path');

const MANIFESTS = path.join(
  process.env.ProgramData || 'C:\\ProgramData',
  'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'
);

async function scanEpic() {
  let files;
  try {
    files = fs.readdirSync(MANIFESTS).filter((f) => f.endsWith('.item'));
  } catch {
    return [];
  }

  const games = [];
  for (const file of files) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(MANIFESTS, file), 'utf8'));
      if (!item.AppName || !item.DisplayName) continue;
      // DLCs apontam para o jogo base em MainGameAppName.
      if (item.MainGameAppName && item.MainGameAppName !== item.AppName) continue;
      if (Array.isArray(item.AppCategories) && !item.AppCategories.includes('games')) continue;

      const appRef = [item.CatalogNamespace, item.CatalogItemId, item.AppName]
        .map(encodeURIComponent).join('%3A');
      games.push({
        id: `epic:${item.AppName}`,
        name: item.DisplayName,
        source: 'Epic',
        covers: [],
        ready: !item.bIsIncompleteInstall,
        folder: item.InstallLocation ? path.normalize(item.InstallLocation) : undefined,
        size: Number(item.InstallSize) || null,
        launch: {
          type: 'url',
          target: `com.epicgames.launcher://apps/${appRef}?action=launch&silent=true`,
        },
        // A Epic não tem link de desinstalação: o máximo é abrir a biblioteca do launcher dela.
        uninstall: { type: 'client', target: 'com.epicgames.launcher://store/library', client: 'Epic Games Launcher' },
      });
    } catch {
      // Manifesto ilegível: ignora só esse jogo.
    }
  }
  return games;
}

module.exports = { scanEpic };

# Ludex

Todos os seus jogos num lugar só. O Ludex é um launcher para Windows que junta numa
biblioteca os jogos da Steam, Epic, GOG, Ubisoft Connect, EA App e os que você adicionar
à mão, com downloads integrados, estatísticas de jogo e backup de saves.

> **Inspirado no [Hydra](https://github.com/hydralauncher/hydra).** A ideia de reunir a
> biblioteca e os downloads (torrent e Real-Debrid) no mesmo app, e de ter fontes de
> download em JSON, vem do Hydra; as fontes do Ludex usam o mesmo formato das dele.
> O Ludex é um projeto independente, não é afiliado ao Hydra e não reaproveita código dele.

## Recursos

- **Biblioteca unificada.** Lê os jogos instalados da Steam, Epic, GOG, Ubisoft Connect,
  EA App e executáveis adicionados à mão. Com as contas conectadas (Steam pela chave da
  Web API; GOG e Epic pelo login da própria loja), mostra também os jogos não instalados.
- **Capas e informações** da loja da Steam e, para o resto, do SteamGridDB.
- **Categorias, filtros e busca**, em grade de capas ou em lista com a página do jogo.
- **Jogando agora e tempo de jogo**, inclusive para jogos fora da Steam, e o total das
  duas últimas semanas.
- **Estatísticas:** horas por dia, sessões, maior sessão, dias seguidos, mais jogados.
- **Downloads:** magnet, `.torrent` e links diretos, com Real-Debrid opcional, escolha dos
  arquivos do torrent e gráfico de velocidade. Continua em segundo plano, na bandeja.
- **Fontes de download em JSON** (formato do Hydra), com busca e filtro por fonte.
- **Backup de saves:** sabe onde milhares de jogos guardam os saves (pelo catálogo do
  [Ludusavi](https://github.com/mtkennerly/ludusavi-manifest)), faz backup ao fechar o jogo
  e restaura com um clique.
- **Desinstalar** pelo desinstalador do próprio jogo ou da loja, **trocar o executável**,
  **tamanho no disco** de cada jogo e **menu rápido** no botão direito.
- **Modo tela grande** para jogar do sofá, navegável pelo controle.
- **Instalador próprio**, no mesmo visual do app.

## Aviso

O Ludex não fornece jogos, links nem fontes de download: ele só baixa o que você colocar
nele. Use com conteúdo que você tem o direito de baixar.

## Compilar

Precisa de Windows 10 ou 11, [Node.js](https://nodejs.org) 22 ou mais novo e do .NET
Framework 4 (já vem no Windows; o instalador próprio é compilado com o `csc` dele).

```bash
npm install
```

```bash
npm start
```

Para gerar o instalador:

```bash
npm run build
```

O resultado é `dist/Ludex Setup <versão>.exe`. Na primeira vez, o build baixa do NuGet a
biblioteca do WebView2, usada pela interface do instalador. O ícone e as imagens do
instalador são gerados por `npm run assets`.

## Estrutura

| Caminho | O que é |
|---|---|
| `main.js` | Processo principal do Electron: varredura dos jogos, contas, sessões, bandeja |
| `renderer/` | Interface do app (HTML, CSS e JS, sem framework) |
| `scanners/` | Leitura dos jogos instalados de cada loja |
| `downloads.js`, `realdebrid.js`, `sources.js` | Downloads, Real-Debrid e fontes em JSON |
| `saves.js` | Backup e restauração de saves |
| `scripts/setup/` | Instalador com interface própria (C# + WebView2) |
| `build/installer.nsh` | Personalização do instalador NSIS que faz a instalação por baixo |

## Créditos

- [Hydra](https://github.com/hydralauncher/hydra), a inspiração.
- [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest), onde ficam os saves de cada jogo.
- [Electron](https://www.electronjs.org), [WebTorrent](https://webtorrent.io), [Lucide](https://lucide.dev) (ícones).
- Fontes [Archivo](https://fonts.google.com/specimen/Archivo) e [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (SIL Open Font License).

## Licença

[GPL-3.0](LICENSE).

# ArXivLibrary

An arXiv-native research library manager for physicists and scientists —
search, organize, and connect papers, all from a fast native desktop app.

![Library view](docs/screenshots/library.png)

## What it does

ArXivLibrary is a desktop research library built around the arXiv workflow —
a fast, arXiv-first way to search, save, and organize papers.

- **arXiv search** — full-text and advanced fielded search, pagination,
  search history, and Cmd+K quick search
- **Library** — save papers into nested, color-coded collections; tags,
  reading status, and markdown notes
- **Daily Feed** — new papers from the arXiv categories you follow
- **Graph view** — force-directed graph connecting related papers
- **Bibliography** — DOI lookup via Crossref, import/export `.bib` and `.ris`
- **Citations & venues** — enriched via Semantic Scholar
- **Custom themes** — full palette engine from base + accent colors
- PDF download and open in your system PDF viewer

## Download

Grab the latest build for your platform from the
[**Releases**](../../releases) page.

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `.dmg` |
| Windows | `.exe` |
| Linux | `.AppImage` or `.deb` |

### Install from the command line

Each release asset can be downloaded directly with `curl`. The
`latest/download` path always points to the newest release.

```bash
# macOS (Apple Silicon)
curl -L -O https://github.com/Pankajsharma05/ArXiv-Library-releases/releases/latest/download/ArXivLibrary.dmg

# Windows (PowerShell)
curl.exe -L -O https://github.com/Pankajsharma05/ArXiv-Library-releases/releases/latest/download/ArXivLibrary.exe

# Linux (AppImage)
curl -L -O https://github.com/Pankajsharma05/ArXiv-Library-releases/releases/latest/download/ArXivLibrary.AppImage
chmod +x ArXivLibrary.AppImage
./ArXivLibrary.AppImage

# Linux (.deb)
curl -L -O https://github.com/Pankajsharma05/ArXiv-Library-releases/releases/latest/download/arxivlibrary.deb
sudo dpkg -i arxivlibrary.deb
```

Make sure the asset filenames match what you upload to each release.

## Installation notes

**Windows** — The app is unsigned, so Windows may show a SmartScreen
warning. Click **More info → Run anyway**. The `.exe` runs directly; no
installer needed.

**macOS** — The app is unsigned. On first launch, right-click the app and
choose **Open**, then confirm. Or run:

```
xattr -cr /Applications/ArXivLibrary.app
```

**Linux** — For the AppImage:

```
chmod +x ArXivLibrary.AppImage
./ArXivLibrary.AppImage
```

For the `.deb`:

```
sudo dpkg -i arxivlibrary.deb
```

## Screenshots

![Graph view](docs/screenshots/graph.png)
![Daily Feed](docs/screenshots/feed.png)

## Feedback

Found a bug or have a feature request? Open an issue or email
pankajsharma6810@gmail.com.

## Acknowledgements

ArXivLibrary is built on top of several free, openly accessible services.
Sincere thanks to the teams and communities behind them:

- **[arXiv](https://arxiv.org)** and its API, for open access to preprints
  and the metadata this app is built around.
- **[Semantic Scholar](https://www.semanticscholar.org)** (Allen Institute
  for AI), for citation counts and venue data via the Semantic Scholar API.
- **[Crossref](https://www.crossref.org)**, for DOI lookup and bibliographic
  metadata.

This project would not be possible without their open APIs. Please review and
respect each service's terms of use and rate limits.

## License

ArXivLibrary is proprietary software, free for personal and academic use.
See [LICENSE](LICENSE) for details.

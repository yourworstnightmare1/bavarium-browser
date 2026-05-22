# Building Bavarium from source

Official repository: [https://github.com/yourworstnightmare1/bavarium-browser](https://github.com/yourworstnightmare1/bavarium-browser)

## Prerequisites

- **Git**
- **Node.js 24 or newer** (matches the bundled Ultraviolet app’s `engines` field; npm is included). Install from [https://nodejs.org](https://nodejs.org).

If `npm install` fails while building native addons, install platform build tools (e.g. Xcode Command Line Tools on macOS, Visual Studio Build Tools with C++ workload on Windows).

## Clone the repository

```bash
git clone https://github.com/yourworstnightmare1/bavarium-browser.git
cd bavarium-browser
```

The project expects **`ultraviolet-app/`** and **`scramjet-app/`** next to `package.json`. They ship with the full source tree; do not replace them with separate clones unless you are intentionally syncing upstream and know what Bavarium expects.

## Install dependencies

Install JavaScript dependencies in **three** places: the Electron shell, then each bundled proxy app.

```bash
npm install
cd ultraviolet-app && npm install && cd ..
cd scramjet-app && npm install && cd ..
```

The Scramjet app runs **`postinstall`** (`patch-package`). That step must finish without errors.

## Run the app (development)

From the repository root:

```bash
npm start
```

## Build installers (optional)

From the repository root:

```bash
npm run dist
```

On **Windows** (PowerShell 5.1+ or PowerShell 7), you can install dependencies and build Windows installers in one step (`-Platform All` builds Windows only; macOS artifacts require a Mac host):

```powershell
.\scripts\build-bavarium.ps1
```

Options: `-Platform Windows|Mac|All`, `-SkipInstall`, `-Clean`, `-Force` (skip confirmation). macOS output is **`release/mac-arm64.zip`** (folder `mac-arm64/` with the `.app`, then zipped by the script). No DMG.

Artifacts are written under **`release/`** (see `package.json` and electron-builder configuration).

## Proxies

Bavarium integrates [Scramjet](https://github.com/MercuryWorkshop/scramjet) and [Ultraviolet](https://github.com/titaniumnetwork-dev/ultraviolet) via the bundled apps above. Configure ports and proxy type in the in-app settings.

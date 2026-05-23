# Building Bavarium from source

Official repository: [https://github.com/yourworstnightmare1/bavarium-browser](https://github.com/yourworstnightmare1/bavarium-browser)

## Prerequisites

- **Git**
- **Node.js 24 or newer** (matches the bundled Ultraviolet app’s `engines` field; npm is included). Install from [https://nodejs.org](https://nodejs.org).

If `npm install` or `electron-builder` fails while building native addons, install platform build tools:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`). On **Python 3.12+**, node-gyp also needs setuptools (distutils was removed): `python3 -m pip install setuptools`. The build script tries to install this automatically on macOS.
- **Windows:** Visual Studio Build Tools with the **Desktop development with C++** workload.

While `npm install` runs, PowerShell may print odd escape sequences (for example `^[[48;1R`); that is terminal noise, not a build error. Wait until npm finishes or shows an explicit `npm ERR!` line.

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

Install dependencies and build with the PowerShell script (needs **PowerShell 7** / `pwsh` on macOS: `brew install powershell`).

From the **repository root**:

```powershell
.\scripts\build-bavarium.ps1
```

On macOS you can also use:

```bash
chmod +x scripts/build-bavarium.sh   # once
./scripts/build-bavarium.sh -Platform Mac -Force
```

Do **not** run only a quoted path like `'/path/to/build-bavarium.ps1'` — PowerShell prints that string and exits. Use `.\scripts\...` from the repo root, or `pwsh -File scripts/build-bavarium.ps1`, or the `.sh` wrapper above.

Options: `-Platform Windows|Mac|All`, `-SkipInstall`, `-Clean`, `-Force` (skip confirmation). On a Mac, use **`-Platform Mac`** if you only need a macOS build (faster than `All`, which also cross-builds Windows). `-Platform All` on Windows builds Windows only; macOS artifacts require a Mac host. macOS output is **`release/mac-arm64.zip`** (folder `mac-arm64/` with the `.app`, then zipped by the script). No DMG.

Artifacts are written under **`release/`** (see `package.json` and electron-builder configuration).

## Proxies

Bavarium integrates [Scramjet](https://github.com/MercuryWorkshop/scramjet) and [Ultraviolet](https://github.com/titaniumnetwork-dev/ultraviolet) via the bundled apps above. Configure ports and proxy type in the in-app settings.

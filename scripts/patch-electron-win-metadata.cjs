/**
 * Patch electron.exe version info on Windows so Task Manager, firewall prompts,
 * and other OS UI show "Bavarium Browser" instead of Electron / package description.
 */
const fs = require('fs');
const path = require('path');

async function main() {
  if (process.platform !== 'win32') {
    return;
  }

  const pkg = require('../package.json');
  const displayName = pkg.productName || pkg.name || 'Bavarium Browser';
  const rawVersion = String(pkg.version || '1.0.0');
  const numericParts = rawVersion.match(/\d+/g) || ['1', '0', '0', '0'];
  while (numericParts.length < 4) {
    numericParts.push('0');
  }
  const fileVersion = numericParts.slice(0, 4).join('.');

  const electronExe = path.join(
    __dirname,
    '..',
    'node_modules',
    'electron',
    'dist',
    'electron.exe'
  );

  if (!fs.existsSync(electronExe)) {
    console.warn('[patch-electron-win-metadata] electron.exe not found; skipping.');
    return;
  }

  let rcedit;
  try {
    rcedit = require('rcedit');
  } catch (err) {
    console.warn('[patch-electron-win-metadata] rcedit not installed; skipping.', err.message);
    return;
  }

  const internalName = displayName.replace(/\s+/g, '');
  const options = {
    'version-string': {
      FileDescription: displayName,
      ProductName: displayName,
      InternalName: internalName,
      OriginalFilename: `${internalName}.exe`,
    },
    'file-version': fileVersion,
    'product-version': fileVersion,
  };

  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  if (fs.existsSync(iconPath)) {
    options.icon = iconPath;
  }

  await rcedit(electronExe, options);
  console.log(`[patch-electron-win-metadata] Updated ${electronExe} -> "${displayName}"`);
}

main().catch((err) => {
  console.warn('[patch-electron-win-metadata] failed:', err.message);
  process.exit(0);
});

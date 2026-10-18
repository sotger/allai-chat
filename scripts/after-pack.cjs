// Ad-hoc signs the macOS app when no Developer ID certificate is configured.
// macOS on Apple Silicon refuses to run completely unsigned arm64 bundles, even
// after the user clears the quarantine flag, so a valid (ad-hoc) signature is
// required for portable builds. Real signing, if configured, happens later and
// replaces this signature.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`  • ad-hoc signing ${appName}.app (no Developer ID certificate)`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  });
};

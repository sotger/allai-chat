# Signing, notarization and auto-updates

ALLAI-CHAT currently ships **ad-hoc signed** macOS builds. They run after the
usual Gatekeeper bypass (right-click → Open), but macOS will not install
automatic updates for them, and users still see a “developer cannot be verified”
warning on first launch.

To remove the warning and enable macOS auto-updates you need an **Apple
Developer Program** membership and a **Developer ID Application** certificate.

## What you need

| Item | Cost / where to get it |
| --- | --- |
| Apple Developer Program membership | $99/year, <https://developer.apple.com/programs/> |
| Developer ID Application certificate | Free with the membership |
| Team ID (10 characters) | <https://developer.apple.com/account> → Membership |
| App-specific password | <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords |

An Apple ID with two-factor authentication is required. The certificate is
created in Xcode or in the developer portal; it is just a file — you do not need
to buy anything else.

## 1. Create the certificate

**With Xcode (easiest):**

1. Xcode → Settings → Accounts → add your Apple ID.
2. Select the team → **Manage Certificates** → **+** → **Developer ID
   Application**.
3. The certificate appears in **Keychain Access** under *My Certificates*.

**Without Xcode:** in the developer portal open *Certificates, Identifiers &
Profiles* → **Certificates** → **+** → **Developer ID Application**, upload a
CSR generated in Keychain Access (*Certificate Assistant → Request a
Certificate From a Certificate Authority*), then download and install the
certificate.

## 2. Export the certificate as .p12

1. Keychain Access → *My Certificates* → find **Developer ID Application: …**.
2. Right-click → **Export** → format **Personal Information Exchange (.p12)**.
3. Set a password — this becomes `CSC_KEY_PASSWORD`.

## 3. Add GitHub Actions secrets

In the repository: **Settings → Secrets and variables → Actions → New
repository secret**.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of the .p12: `base64 -i certificate.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | the .p12 export password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | your 10-character Team ID |

The release workflow already passes these variables to `electron-builder`.
When they are present, electron-builder signs the app and notarizes it
automatically (`@electron/notarize` / `notarytool`); when they are absent, the
build falls back to ad-hoc signing via `scripts/after-pack.cjs`.

> Prefer an App Store Connect API key? Set `APPLE_API_KEY`,
> `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` instead of the Apple ID secrets.

## 4. Cut a signed release

```bash
npm version patch --no-git-tag-version
git commit -am "release: vX.Y.Z"
git push
git tag -a vX.Y.Z -m "ALLAI-CHAT X.Y.Z"
git push origin vX.Y.Z
```

Verify the downloaded build:

```bash
codesign -dv --verbose=4 "/Applications/ALLAI-CHAT.app"     # Authority=Developer ID Application
spctl -a -vv "/Applications/ALLAI-CHAT.app"                # accepted, source=Notarized Developer ID
xcrun stapler validate "/Applications/ALLAI-CHAT.app"      # The validate action worked
```

## 5. Auto-updates

The app uses `electron-updater` against GitHub Releases. The release workflow
builds and uploads:

- `latest-mac.yml` + `*.zip` (macOS, both architectures; the updater picks the
  matching zip automatically),
- `latest.yml` + `*.exe` (Windows NSIS),
- `latest-linux.yml` + `*.AppImage` (Linux).

Behaviour:

- **Windows / Linux AppImage:** updates are downloaded in the background and
  installed on restart (or via **Help → Check for Updates…**).
- **macOS:** auto-update requires a Developer ID signature. On an unsigned
  build the same menu item explains this and opens the Releases page. Once a
  signed build is installed, subsequent releases update automatically.
- **Linux .deb:** no self-update; install the new package.

After the first signed release, macOS auto-updates work with no additional
configuration.

## Windows code signing (optional)

Windows builds are unsigned, so SmartScreen shows “More info → Run anyway” on
first launch. If you want to remove that, buy an OV/EV code-signing certificate
from a CA and add its `.pfx` as `CSC_LINK` / `CSC_KEY_PASSWORD` for the Windows
job (use separate secrets; do not reuse the Apple certificate).

## Notes

- Notarization uploads the app to Apple’s notary service and typically takes a
  few minutes per architecture.
- The ad-hoc fallback in `scripts/after-pack.cjs` is intentional: without a
  Developer ID, macOS on Apple Silicon refuses to launch completely unsigned
  arm64 bundles.
- Never commit certificates, passwords or API keys. Keep them in GitHub
  Actions secrets only.

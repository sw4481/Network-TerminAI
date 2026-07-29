# Release Process

This document describes the process for creating releases of CCIE Terminal, including code signing, building installers, and publishing updates.

## Overview

CCIE Terminal uses GitHub Actions to automate the release process. Releases are triggered by pushing a version tag (e.g., `v1.0.0`) to the repository.

## Release Workflow

### 1. Pre-Release Checklist

Before creating a release:

- [ ] All tests pass (`cargo test`, `pytest`, `bun test`)
- [ ] CHANGELOG.md is updated with new version and release notes
- [ ] Version numbers are synchronized:
  - `package.json` → `version`
  - `src-tauri/Cargo.toml` → `version`
  - `src-tauri/tauri.conf.json` → `version`
- [ ] Documentation is up to date
- [ ] Security audit completed (if applicable)
- [ ] Manual testing on macOS and Windows

### 2. Create Release Tag

```bash
# Update version in all files (see above)
git add .
git commit -m "chore: bump version to 1.0.0"

# Create and push tag
git tag v1.0.0
git push origin v1.0.0
```

### 3. GitHub Actions Workflow

The `.github/workflows/release.yml` workflow will automatically:

1. Create a draft GitHub release
2. Build the application for macOS (Intel + Apple Silicon) and Windows
3. Run all tests before building
4. Sign the applications (if credentials are configured)
5. Create installers:
   - macOS: `.dmg` and `.app.tar.gz`
   - Windows: `.exe` (NSIS installer) and `.msi`
6. Upload artifacts to the GitHub release
7. Publish the release (remove draft status)

### 4. Monitor Release Build

1. Go to the [Actions tab](https://github.com/sw4481/ccie-terminal/actions) on GitHub
2. Watch the "Release" workflow for your tag
3. Check for any build failures or test failures
4. Review build logs if issues occur

### 5. Post-Release

Once the release is published:

1. Verify the release notes on GitHub
2. Test the installers on both platforms
3. Update any external documentation or marketing materials
4. Announce the release (social media, blog, etc.)

## Code Signing

Code signing is required for macOS and Windows releases to avoid security warnings on user systems.

### macOS Code Signing

#### Requirements

1. **Apple Developer Account** ($99/year)
   - Individual or Organization account
   - Enroll at https://developer.apple.com/programs/

2. **Developer ID Application Certificate**
   - Create in Apple Developer Portal → Certificates
   - Download and install in Keychain Access
   - Export as `.p12` file

3. **App-Specific Password for notarization**
   - Create at https://appleid.apple.com/account/manage
   - Used for `xcrun notarytool`

#### Setup GitHub Secrets

Add these secrets to your repository (Settings → Secrets and variables → Actions):

```
APPLE_CERTIFICATE: Base64-encoded .p12 certificate
APPLE_CERTIFICATE_PASSWORD: Password for .p12 file
APPLE_SIGNING_IDENTITY: Certificate Common Name (e.g., "Developer ID Application: Your Name (TEAM_ID)")
APPLE_ID: Your Apple ID email
APPLE_PASSWORD: App-specific password
APPLE_TEAM_ID: Your Team ID from developer.apple.com
```

To encode the certificate:
```bash
base64 -i certificate.p12 | pbcopy
```

#### Notarization Process

The Tauri Action automatically handles notarization:
1. Build and sign the `.app` bundle
2. Create a `.dmg` installer
3. Submit to Apple's notary service
4. Staple the notarization ticket
5. Upload to GitHub release

**Note**: Notarization can take 5-15 minutes per build.

### Windows Code Signing

#### Requirements

1. **Code Signing Certificate**
   - Purchase from a Certificate Authority (DigiCert, Sectigo, etc.)
   - Costs ~$100-$500/year
   - Requires organization verification

2. **Certificate Thumbprint**
   - Extract from certificate file
   - Used to identify the certificate during signing

#### Setup GitHub Secrets

Add these secrets to your repository:

```
WINDOWS_CERTIFICATE: Base64-encoded .pfx or .p12 certificate
WINDOWS_CERTIFICATE_PASSWORD: Password for certificate file
WINDOWS_CERTIFICATE_THUMBPRINT: Certificate thumbprint (SHA-1 hash)
```

The workflow uses `signtool.exe` (included with Windows SDK) to sign executables.

### Tauri Updater Signing

The Tauri updater uses separate signing keys for update verification.

#### Generate Updater Keys

```bash
# Install Tauri CLI if not already installed
cargo install tauri-cli

# Generate signing key pair
tauri signer generate -w ~/.tauri/myapp.key
```

This creates:
- Private key: `~/.tauri/myapp.key` (keep secret!)
- Public key: Printed to stdout (add to `tauri.conf.json`)

#### Setup GitHub Secret

```
TAURI_SIGNING_PRIVATE_KEY: Contents of private key file
TAURI_SIGNING_PRIVATE_KEY_PASSWORD: Password (if encrypted)
```

#### Configure Public Key

Add the public key to `src-tauri/tauri.conf.json`:

```json
{
  "app": {
    "updater": {
      "active": true,
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QxMjM0..."
    }
  }
}
```

## Auto-Updates

CCIE Terminal supports automatic updates via Tauri's built-in updater.

### Update Mechanism

1. On app launch, check for updates from GitHub releases
2. Download and verify new version (signature check)
3. Show notification to user with "Update" button
4. Install update on next restart

### Update Endpoint

The updater checks:
```
https://github.com/sw4481/ccie-terminal/releases/latest/download/latest.json
```

This file is automatically generated by `tauri-action` and contains:
- Latest version number
- Download URLs for each platform
- Signatures for verification

### Testing Updates

To test the update mechanism:

1. Create a new release with a higher version number
2. Build and sign the release
3. In a previous version of the app, the updater should detect the new version
4. Click "Update" to download and install

**Note**: The updater only works with signed builds (not dev builds).

## Manual Release Process

If GitHub Actions is unavailable, you can build releases locally:

### Prerequisites

- Rust stable toolchain
- Bun and Node.js
- Python 3.12
- Platform-specific tools:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio Build Tools

### Build Steps

```bash
# 1. Clean previous builds
rm -rf src-tauri/target/release

# 2. Install dependencies
bun install
cd sidecar && pip install -e '.[dev]' && cd ..

# 3. Run tests
cargo test --manifest-path src-tauri/Cargo.toml
cd sidecar && pytest && cd ..
bun test

# 4. Build release
bun tauri build

# 5. Find installers
ls -lh src-tauri/target/release/bundle/
```

Installers will be in:
- macOS: `src-tauri/target/release/bundle/dmg/` and `src-tauri/target/release/bundle/macos/`
- Windows: `src-tauri/target/release/bundle/nsis/` and `src-tauri/target/release/bundle/msi/`

### Manual Code Signing

#### macOS

```bash
# Sign the app bundle
codesign --force --options runtime --deep \
  --sign "Developer ID Application: Your Name (TEAM_ID)" \
  src-tauri/target/release/bundle/macos/CCIE\ Terminal.app

# Create DMG
hdiutil create -volname "CCIE Terminal" -srcfolder \
  src-tauri/target/release/bundle/macos/CCIE\ Terminal.app \
  -ov -format UDZO CCIE-Terminal.dmg

# Sign DMG
codesign --force --sign "Developer ID Application: Your Name (TEAM_ID)" \
  CCIE-Terminal.dmg

# Submit for notarization
xcrun notarytool submit CCIE-Terminal.dmg \
  --apple-id your@email.com \
  --password abcd-efgh-ijkl-mnop \
  --team-id TEAM_ID \
  --wait

# Staple notarization ticket
xcrun stapler staple CCIE-Terminal.dmg
```

#### Windows

```bash
# Sign the installer
signtool sign /f certificate.pfx /p password \
  /t http://timestamp.digicert.com \
  src-tauri/target/release/bundle/nsis/CCIE-Terminal_1.0.0_x64-setup.exe
```

## Troubleshooting

### Build Fails on macOS

- **Issue**: `cargo build` fails with linker errors
- **Solution**: Install Xcode Command Line Tools: `xcode-select --install`

### Build Fails on Windows

- **Issue**: Missing Visual C++ tools
- **Solution**: Install Visual Studio Build Tools with C++ support

### Notarization Fails

- **Issue**: Apple notary service rejects the app
- **Solution**: Check for unsigned dylibs or frameworks: `codesign --verify --deep --strict --verbose=2 path/to/app`

### Update Check Fails

- **Issue**: App doesn't detect updates
- **Solution**: 
  1. Verify `latest.json` exists in GitHub releases
  2. Check public key matches in `tauri.conf.json`
  3. Ensure running a signed build (not dev mode)

### Tests Fail in CI

- **Issue**: Tests pass locally but fail in GitHub Actions
- **Solution**: Check for environment-specific issues (paths, permissions, network access)

## Version Numbering

CCIE Terminal follows [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Breaking changes, incompatible API changes
- **MINOR** (1.X.0): New features, backward-compatible
- **PATCH** (1.0.X): Bug fixes, backward-compatible

Examples:
- `1.0.0` → First stable release
- `1.1.0` → Add new AI provider support
- `1.1.1` → Fix crash in command parser
- `2.0.0` → Change MCP protocol (breaking)

## Release Cadence

- **Patch releases**: As needed for critical bugs (within days)
- **Minor releases**: Monthly for new features
- **Major releases**: Annually or when breaking changes are necessary

## Contact

For questions about the release process:
- Open an issue: https://github.com/sw4481/ccie-terminal/issues
- Email: [your-email@example.com]

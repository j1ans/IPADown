# ipaDown

ipaDown is an Electron app for browsing and downloading IPA files, organizing a local IPA library, installing compatible packages on connected iOS devices, and recovering older versions. The interface supports Chinese and English.

## Run locally

```bash
npm ci
npm test
npm start
```

The app saves settings and its SQLite library index in Electron's `userData` directory. IPA files stay in the selected download folder.

## Accounts

Sign in with an Apple Account in the Account tab. If Apple requests two-factor authentication, enter the six-digit code and sign in again. The top bar lets you switch between saved accounts. Rescue jobs use the account currently selected there.

When **Remember this account** is enabled, passwords and sessions are encrypted with Electron `safeStorage` and saved locally. If the operating system does not offer secure storage, credentials are kept for the current run only. No credentials, cookies, purchase databases, or downloaded IPA files belong in the repository.

Authentication uses a local Go bridge built against [ipatool v2.6.0](https://github.com/majd/ipatool/releases/tag/v2.6.0). It fetches Apple's current Store bag and signs the login request with SAP. The app passes the password and optional two-factor code to the bridge over stdin, never as command-line arguments. The returned session is kept in memory or encrypted locally according to the Remember setting. Apple's private store protocol can still change; the code does not bypass ownership or device restrictions.

## Library and device installation

The library scans IPA files recursively and caches parsed metadata in an indexed SQLite database. Unchanged files are not unpacked again. Packages are grouped by numeric App ID from `iTunesMetadata.plist`, with Bundle ID as a fallback. Each app displays one preferred compatible IPA, removes duplicate versions, and lists other supported versions underneath. The device's reported iOS version and each IPA's `MinimumOSVersion` determine whether installation is offered.

On Windows, the app uses the bundled `libimobiledevice` tools. On macOS, install `libimobiledevice` and `ideviceinstaller` with Homebrew. On Linux, install your distribution's `libimobiledevice` utilities, `ideviceinstaller` and `usbmuxd`; ensure your user can access the USB device. You can select a custom tools directory in Settings. Modern `ideviceinstaller` subcommands and the older Windows CLI syntax are both supported.

## Rescue

The **Discontinued app rescue** tab accepts an IPA or plist, extracts App IDs and known version IDs, and attempts to recover older versions. It reuses the current account session and does not upload files to a cloud service.

## Build

`npm start` and `npm run dist` build the authentication bridge first; source builds require Go 1.25 or newer. Packaged releases include the bridge and do not require Go. GitHub Actions builds Windows x64, Linux x64, macOS Intel and macOS Apple Silicon packages. After all four builds succeed, it automatically publishes a [GitHub Release](https://github.com/j1ans/IPADown/releases) with the installers and SHA-256 checksums. Each push to `main` gets a unique `v<package-version>-build.<run-number>` tag; a pushed `v*` tag uses that tag for its release. Pull requests build without publishing. macOS packages are unsigned; users may need to approve them locally. The workflow uses GitHub's built-in token and does not need Apple credentials or repository secrets.

The authentication bridge uses ipatool under its [MIT license](third_party/ipatool-LICENSE).

The StoreKit/Configurator protocol notes are in [PROTOCOL.md](PROTOCOL.md). For the device-tool project and its supported platforms, see [libimobiledevice](https://libimobiledevice.org/) and [ideviceinstaller](https://github.com/libimobiledevice/ideviceinstaller).

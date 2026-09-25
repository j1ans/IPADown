# ipaDown

ipaDown is an Electron app for browsing and downloading IPA files, organizing a local IPA library, installing compatible packages on connected iOS devices, backing up owned apps, and recovering older versions. The interface supports Chinese and English.

## Run locally

```bash
npm ci
npm test
npm start
```

The app saves settings and its SQLite library index in Electron's `userData` directory. IPA files stay in the selected download or backup folder. The backup folder defaults to `userData/ipa-backups`.

## Accounts

Sign in with an Apple Account in the Account tab. If Apple requests two-factor authentication, enter the six-digit code and sign in again. The top bar lets you switch between saved accounts. Backup and rescue jobs use the account currently selected there.

When **Remember this account** is enabled, passwords and sessions are encrypted with Electron `safeStorage` and saved locally. If the operating system does not offer secure storage, credentials are kept for the current run only. No credentials, cookies, purchase databases, or downloaded IPA files belong in the repository.

Apple can change its private store protocol. Authentication, free-license acquisition and downloads require a valid account and may require signing in again. The code does not bypass ownership or device restrictions.

## Library and device installation

The library scans IPA files recursively and caches parsed metadata in an indexed SQLite database. Unchanged files are not unpacked again. Packages are grouped by numeric App ID from `iTunesMetadata.plist`, with Bundle ID as a fallback. Each app displays one preferred compatible IPA, removes duplicate versions, and lists other supported versions underneath. The device's reported iOS version and each IPA's `MinimumOSVersion` determine whether installation is offered.

On Windows, the app uses the bundled `libimobiledevice` tools. On macOS, install `libimobiledevice` and `ideviceinstaller` with Homebrew. On Linux, install your distribution's `libimobiledevice` utilities, `ideviceinstaller` and `usbmuxd`; ensure your user can access the USB device. You can select a custom tools directory in Settings. Modern `ideviceinstaller` subcommands and the older Windows CLI syntax are both supported.

## Backup and rescue

The **IPA backup** tab reads an existing purchase SQLite database for the current account, then downloads owned versions locally. The **Discontinued app rescue** tab accepts an IPA or plist, extracts App IDs and known version IDs, and attempts to recover older versions. These tasks reuse the current account session. Neither task uploads files to a cloud service.

## Build

`npm run dist` builds the current platform. GitHub Actions builds Windows x64, Linux x64, macOS Intel and macOS Apple Silicon packages and uploads them as workflow artifacts. macOS packages are unsigned; users may need to approve them locally. The workflow does not need Apple credentials or repository secrets.

The StoreKit/Configurator protocol notes are in [PROTOCOL.md](PROTOCOL.md). For the device-tool project and its supported platforms, see [libimobiledevice](https://libimobiledevice.org/) and [ideviceinstaller](https://github.com/libimobiledevice/ideviceinstaller).

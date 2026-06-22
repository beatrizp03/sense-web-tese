# Table of Contents

-   [Introduction](#introduction)
-   [Project Structure](#project-structure)
-   [Packages](#packages)
-   [Applications](#applications)
-   [Setting Up the Development Environment](#setting-up-the-development-environment)
    -   [Prerequisites](#prerequisites)
    -   [Installing the Prerequisites](#installing-the-prerequisites)
    -   [Running the Development Environment](#running-the-development-environment)
    -   [Building the Repository](#building-the-repository)
-   [sense-desktop (Electron Desktop App)](#sense-desktop)
    -   [Quick Start](#quick-start)
    -   [Troubleshooting](#troubleshooting)
        -   [Linux (Ubuntu)](#linux-ubuntu)
        -   [Windows](#windows)
-   [Contributing](#contributing)
-   [Disclaimer](#disclaimer)
-   [Acknowledgements](#acknowledgements)

# Introduction

This repository contains the source code for SENSE WEB, a user-friendly
application that helps acquire time series data, such as biosignals, without the
need for coding.

In addition to SENSE WEB, the repository also features others packages, the main
two are: `@scientisst/sense` and `@scientisst/next-ui`. The first package
provides an API for acquiring data from ScientISST devices, while the second is
a React component library offering a set of components for building applications
similar to SENSE WEB.

By having all of these packages in a single monorepo, the goal is to simplify
development and make it easier for new contributors to join in. Keeping
everything in one place streamlines the development process, saving time and
resources.

# Project Structure

This repository is structured using [turborepo](https://turbo.build/), a
monorepo management tool that makes it easier to work on multiple packages and
applications within the same repository.

The following directories can be found in the repository:

-   `/packages/` - This directory contains the source code for the packages that
    are published to npm. The packages in this directory provide functionality
    that can be used by the applications in the repository or by other
    applications that want to use the same functionality.

-   `/apps/` - This directory contains the source code for the applications in
    the repository. These applications are built using the packages in the
    `/packages/` directory, and can be used as examples of how to use those
    packages.

The project structure is designed to make it easy for developers to work on
multiple packages and applications at the same time, as well as to make it
easier for new contributors to get involved. By keeping everything in one place,
it is possible to make changes to the packages and see how they impact the
applications in real-time, saving time and effort during the development
process.

# Packages

This repository contains the following packages:

1. [`@scientisst/sense`]() - A JavaScript library that provides an API for
   acquiring data from ScientISST devices. The library makes it easy to access
   data from these devices, allowing developers to focus on the application
   logic instead of worrying about the communication with the devices.

2. [`@scientisst/next-ui`]() - A React component library that provides a set of
   components for building applications that acquire data from ScientISST
   devices. The components in this library have been designed with SENSE WEB in
   mind, and can be reused in other projects that want to leverage the interface
   developed in SENSE WEB.

3. [`@scientisst/eslint-config-next`]() - An ESLint configuration used by all
   packages in this repository. It ensures a consistent coding style across all
   packages, making it easier for contributors to get started and for maintainers
   to review code changes.

4. [`@scientisst/prettier-config-next`]() - A Prettier configuration used by
   this repository. Prettier is an opinionated code formatter that helps enforce
   consistent coding style and reduces the need for manual code formatting.

5. [`@scientisst/tsconfig`]() - A set of TypeScript configuration files that
   provide a useful set of options for TypeScript projects. This package can be
   used as a dependency in other projects to ensure that they have the same
   TypeScript configuration as this repository.

Each package has its own directory within the repository and its own
documentation, making it easy to understand and use each package independently.
The packages can be installed and used as dependencies in other projects, making
it simple to reuse the work that has already been done.

If you want to learn more a specific package, please start by reading its
README file.

# Applications

This repository also contains the source code for the following applications:

1. [`sense-web-v2`]() - The updated version of SENSE WEB, built using Next.js 13.
   This version provides a user-friendly web interface that makes it easy to
   acquire time series data, such as biosignals, without the need for coding. It
   utilizes the @scientisst/sense library for communication with ScientISST
   devices and the @scientisst/next-ui library for its user interface components.

2. [`sense-web-v1`]() - The original version of SENSE WEB, built using Vue.js.
   This version is kept for backwards compatibility in case any issues arise in
   the new version.

The apps directory within the repository contains the source code for the
applications, making it easy to understand how they are built and how they use
the packages in the repository. The applications can be built and run locally,
allowing developers to work on the code and test their changes before submitting
a pull request.

By having the applications and packages together in the same repository, it is
possible to make changes to the packages that are used by the applications, test
those changes in the applications, and then publish the updated packages to npm.
This streamlined development process speeds up development time and ensures that
the packages and applications are always in sync.

# Setting Up the Development Environment

Before you can start contributing to this repository, you will need to set up
your development environment. The following steps will guide you through the
process.

## Prerequisites

-   Node.js version 20.20.0 or higher
-   pnpm 10.30.1 or higher

## Installing the Prerequisites

You can install the latest version of Node.js by visiting the
[Node.js website](https://nodejs.org/en/download/). After installing Node.js,
you should upgrade npm to the latest version by running the following command:

```bash
npm install -g npm
```

To install pnpm, you should visit the installation instructions on the
[pnpm website](https://pnpm.io/installation).

## Running the Development Environment

Once you have installed the prerequisites, you can clone this repository and
run the following command in the root directory of the repository to install
all of the dependencies:

```bash
pnpm install
```

To start the development environment, run the following command:

```bash
pnpm dev
```

This command will start a development server for each application in the
repository. You can access the development server for each application by
visiting the following URLs:

-   http://localhost:3000 - The development server for the new version of SENSE
    WEB
-   http://localhost:3001 - The development server for the old version of SENSE
    WEB

## Building the Repository

To build the repository, run the following command:

```bash
pnpm build
```

This command will build all of the applications and packages in the repository,
creating a production-ready build that can be deployed to a live environment.
The build artifacts will be stored in a directory within each application and
package.

# sense-desktop

`sense-desktop` is the Electron-based desktop version of SENSE WEB. It wraps the
`sense-web-v2` Next.js app in a native window for data acquisition, export, and
device integration. You do **not** need to run `sense-web-v2` separately,  the
desktop app handles everything.

## Requirements

-   Node.js v20.20.0 or higher
-   pnpm v10.30.1 or higher
-   Python **3.11 or 3.12** - only needed for the post-hoc analysis worker
    (ECG/EDA/PPG/RSP/PCG/ACC).
-   Windows, macOS, or Linux (tested mainly on Windows; see
    [Running on Linux (Ubuntu)](#running-on-linux-ubuntu) for extra Linux steps)

## Quick Start

```bash
# 1. Install dependencies (on Windows run from Git Bash)
git clone <repo-url>
cd sense-web-tese
git checkout electron-version
pnpm install

# 2. Install the Python analysis packages (skip if you don't need analysis)
pip install -r apps/sense-desktop/python/requirements.txt

# 3. Build and launch the desktop app
pnpm build:desktop
pnpm start:desktop
```

That's it! `start:desktop` opens the Electron window automatically.

**Good to know:**

-   Re-run `pnpm build:desktop` only after changing the web app.
-   Developing? Use `pnpm dev:desktop` instead for hot-reload (Next.js dev server
    + Electron together, no separate build step).
-   After installing the Python packages, close and reopen your terminal. Check
    your version with `python --version`; if analysis is skipped you'll see
    `BioSPPy module ... is unavailable` warnings.

## Troubleshooting

Pick your platform: [Linux (Ubuntu)](#linux-ubuntu) or [Windows](#windows). Each
entry below shows the error (or symptom) and how to fix it.

### Linux (Ubuntu) Troubleshooting
---
Do the [Quick Start](#quick-start) first. On Linux you'll likely hit the issues
below.

#### Electron exits immediately with a sandbox error

```
[FATAL:setuid_sandbox_host.cc] The SUID sandbox helper binary was found, but is
not configured correctly. Rather than run without sandboxing I'm aborting now.
You need to make sure that chrome-sandbox is owned by root and has mode 4755.
```

`chrome-sandbox` must be root-owned and setuid. Re-run this after any fresh
`pnpm install`; adjust the version in the path if your Electron differs:

```bash
SANDBOX=node_modules/.pnpm/electron@40.6.1/node_modules/electron/dist/chrome-sandbox
sudo chown root:root "$SANDBOX"
sudo chmod 4755 "$SANDBOX"
```

#### The app starts but no window appears

With hardware acceleration disabled, Electron's `ready-to-show` event never
fires, so the window stays hidden even though the process is running. In
`apps/sense-desktop/main.js`, find the `createWindow()` function (around line
431) and change `show: false` to `show: true`:

```js
const win = new BrowserWindow({
  width: 1200,
  height: 800,
  show: true,   // ← previously: show: false
  ...
});
```

With `show: true`, the `ready-to-show` handler further down
(`win.once("ready-to-show", () => win.show())`) is no longer needed, you can
leave it or remove it.

#### The device never shows up in the app

The app's Bluetooth discovery is Windows-only (it uses PowerShell), so on Linux
you must expose the device as a serial port yourself. Pair it and bind an rfcomm
port (replace the MAC address with your device's):

Your board's address is printed on the board itself (e.g. `C0:49:EF:A3:29:9A`).
Use it in place of the example address below:

```bash
bluetoothctl
# in the bluetoothctl prompt, type these one at a time:
#   scan on
#   pair C0:49:EF:A3:29:9A
#   trust C0:49:EF:A3:29:9A
#   exit

# back in your normal terminal:
sudo rfcomm bind 0 C0:49:EF:A3:29:9A
sudo chmod 666 /dev/rfcomm0   # creates /dev/rfcomm0, the serial port the app reads
```

#### `pip install` fails with "externally-managed-environment"

```
error: externally-managed-environment
× This environment is externally managed
```

Ubuntu blocks system-wide pip installs (PEP 668). Install the analysis packages
into a virtual environment instead, and keep it activated when running analysis
(otherwise you'll get `BioSPPy module ... is unavailable` warnings):

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r apps/sense-desktop/python/requirements.txt
```

### Windows Troubleshooting
---
#### `Electron failed to install correctly`

If `pnpm start:desktop` fails with:

```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
    at getElectronPath (.../node_modules/.pnpm/electron@40.6.1/node_modules/electron/index.js:17:11)
```

the Electron binary didn't extract successfully. On Windows this is usually
**Windows Defender (or another antivirus) silently blocking the extraction** of
`electron.exe`,  the download completes but the file write is quarantined,
leaving the install incomplete.

**Fix: install Electron manually** (no Defender changes needed). Downloading via
the browser and extracting in File Explorer triggers different Defender
behaviour than the Node.js postinstall, so it usually works:

1. **Download the Electron zip** in your browser:
   ```
   https://github.com/electron/electron/releases/download/v40.6.1/electron-v40.6.1-win32-x64.zip
   ```

2. **Delete the broken `dist` folder:**
   ```bash
   rm -rf node_modules/.pnpm/electron@40.6.1/node_modules/electron/dist
   ```

3. **Extract the zip contents into a new `dist` folder.** In File Explorer, go to
   `<path-to-project>\node_modules\.pnpm\electron@40.6.1\node_modules\electron\`,
   create a `dist` folder, and extract **the contents of the zip** (not the zip
   itself) into it,  you should end up with `...\electron\dist\electron.exe`.

4. **Create a `path.txt` file** in the `electron` folder (one level above
   `dist`) containing exactly one line:
   ```
   electron.exe
   ```

5. **Run the app** again with `pnpm start:desktop`.

# Contributing

We welcome contributions to this repository! If you would like to contribute,
please follow these steps:

1. **Fork the repository.** This will create a copy of the repository under your
   own account.

2. **Clone the repository.** This will copy the repository to your local
   machine, allowing you to make changes to the code.

3. **Create a new branch.** It is best to create a new branch for each set of
   changes you would like to make. This helps to keep your changes organized and
   makes it easier for you to submit multiple sets of changes as separate pull
   requests.

4. **Make your changes.** This is the fun part! You can use any text editor or
   integrated development environment (IDE) to make changes to the code.

5. **Commit your changes.** This will save your changes to your local
   repository.

6. **Push your changes.** This will upload your changes to your fork of the
   repository on GitHub.

7. **Submit a pull request.** This will ask the maintainers of the repository to
   review and merge your changes into the main codebase.

Once your changes have been reviewed and approved, they will be merged into the
main codebase and published to the repository for everyone to use.

We appreciate your contributions to this project!

# Disclaimer

Please note that the hardware and software developed by ScientISST are not
medically approved for diagnosing or treating any diseases. The software is
provided "as is" and comes with no warranty, either express or implied,
including but not limited to warranties of merchantability and fitness for a
particular purpose, or non-infringement. The authors and copyright holders
cannot be held liable for any claims, damages, or other liabilities arising from
or in connection with the software or its use.

# Acknowledgements

This project was partially funded by Fundação para a Ciência e a Tecnologia
(FCT) through the following initiatives:

-   UIDB/50008/2020 and DSAIPA/AI/0122/2020 (AIMHealth) at Instituto de Telecomunicações
-   B-0169-22 (AIMHealth) at Instituto de Telecomunicações

We are grateful for their support.
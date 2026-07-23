
# polygenic_risk_scores SDK

A browser-native and Node-compatible JavaScript SDK and demo application for calculating polygenic risk scores (PRS) from 23andMe and PGS Catalog data.

Live demo: https://lorenasandoval88.github.io/polygenic_risk_scores/

[<img width="755" height="778" alt="image" src="https://github.com/user-attachments/assets/24506e93-3aef-4e5d-9402-32686acf056d" />](https://lorenasandoval88.github.io/polygenic_risk_scores/)

---

## Overview

This toolkit enables:
- Automated retrieval and parsing of 23andMe and PGS Catalog data
- Calculation of polygenic risk scores (PRS) for local or public genomes
- Browser-based and Node.js/Cloud Run compatible workflows
- Simple developer APIs for PRS research and visualization

---

## Quick Start


### Browser SDK

```js
// ESM direct import (browser)
const sdk = await import("https://lorenasandoval88.github.io/polygenic_risk_scores/dist/sdk.mjs");
// or via npm: import { fetchAllScores, fetchTraits, getTxts } from "polygenic_risk_scores";
```

### Node/Cloud Run SDK

```js
// ESM direct import (Node/Cloud Run)
const sdk = await import("https://lorenasandoval88.github.io/polygenic_risk_scores/dist/cloud_sdk.mjs");
// or via npm: import { fetchAllScores, ... } from "polygenic_risk_scores/cloud_sdk.mjs";
```

---

## Architecture

```
polygenic_risk_scores/
├── src/
│   ├── app/           # Browser app entry and UI wiring
│   ├── sdk/           # Reusable SDK modules (PGP, PGS, PRS)
│   └── css/           # App styles
├── data/              # Local 23andMe-compatible genome files
├── dist/              # Rollup build outputs
│   ├── sdk.mjs        # Browser SDK
│   └── cloud_sdk.mjs  # Node-safe SDK
├── sdk.js             # Public SDK entrypoint
├── index.html         # Web interface
├── rollup.config.js   # Build configuration
├── package.json       # Project dependencies and scripts
└── README.md          # Documentation
```

| Directory/File       | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| **src/app/**         | Browser app entry and UI logic                           |
| **src/sdk/**         | SDK modules for PGP, PGS, PRS                            |
| **src/css/**         | Stylesheets                                              |
| **data/**            | Local genome files                                       |
| **dist/**            | Compiled SDK outputs (browser & node)                    |
| **sdk.js**           | Public API entry point                                   |
| **index.html**       | Web interface                                            |
| **rollup.config.js** | Bundler configuration                                    |
| **package.json**     | Project dependencies and scripts                         |
| **README.md**        | Documentation                                            |

---

## Core Functions

### Public API Functions

| Function | Description |
|---|---|
| `fetchAllScores()` | Fetch all PGS Catalog scores |
| `fetchSomeScores(ids)` | Fetch specific PGS scores by ID |
| `fetchTraits()` | Fetch trait metadata |
| `getScoresPerTrait()` | Get scores grouped by trait |
| `getScoresPerCategory()` | Get scores grouped by category |
| `getTxts(ids)` | Fetch and parse PGS text files |
| `estimateLocalForageSizeKB()` | Estimate LocalForage storage size (Browser only) |
| `checkStorageKB()` | Check storage usage and quota (Browser only) |
| `getTextSizeKB(text)` | Calculate text size in KB (Browser only) |
| `fetchAvailableDataTypes()` | List available data types |
| `allUsersMetaDataByType_fast()` | Get user metadata by type |
| `fetchProfile(id)` | Fetch a user profile |
| `get23Txt(path, id, cache)` | Load and parse a 23andMe file |
| `Match2(pgsTxt, my23Txt)` | Calculate PRS (2-input) |
| `Match3(pgsTxt, my23Txt)` | Calculate PRS (3-input) |

**SDK Availability:**
- **Browser SDK (`sdk.mjs`)**: All functions above
- **Node SDK (`cloud_sdk.mjs`)**: All functions except browser-only storage utilities (`estimateLocalForageSizeKB`, `checkStorageKB`, `getTextSizeKB`)

---

## Usage Example

```js
import { fetchAllScores, fetchTraits, getTxts } from "polygenic_risk_scores";

const scores = await fetchAllScores();
const traits = await fetchTraits();
const txts = await getTxts(["PGS000001"]);
```

---

## Build

Run `npm run build` to generate:
- `dist/sdk.mjs` (browser SDK)
- `dist/cloud_sdk.mjs` (Node-safe SDK)

---

## Run

- Open `index.html` with a local static server (e.g. VS Code Live Server)
- For API calls, use the browser or Node SDK as shown above

---

## License

MIT

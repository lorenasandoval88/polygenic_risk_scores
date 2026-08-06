// Node-safe SDK entry for Cloud Run (no browser APIs)
export {
  fetchAvailableDataTypes,
  allUsersMetaDataByType_fast,
  fetchProfile,
  get23Txt
} from "./pgp_node.js";

export {
  fetchAllScores,
  fetchSomeScores,
  fetchTraits,
  getScoresPerCategory,
  getScoresPerTrait,
  getPgsTxt
} from "./pgs_node.js";

export {
  Match2
} from "./prs_node.js";

// No browser-only code, no Plotly, no D3, no localforage, no window/document
// Imports from npm packages (pgp, pgs) and local files (prs)

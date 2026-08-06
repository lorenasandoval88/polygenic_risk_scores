// Node-safe PGS Catalog SDK wrapper - imports from npm package instead of HTTPS URL
// For Node.js/Cloud Run environments
export {
	fetchAllScores,
	fetchSomeScores,
	fetchTraits,
	getScoresPerTrait,
	getScoresPerCategory,
	getTxts as getPgsTxt,
	loadScoreStats
} from "pgs_catalog_sdk/cloud_sdk.mjs";

import { Storage } from "@google-cloud/storage";

import {
  fetchAllScores,
  getPgsTxt,
  fetchAvailableDataTypes,
  allUsersMetaDataByType_fast,
  fetchProfile,
  get23Txt,
  Match2
} from "./cloud_sdk.mjs";

const storage = new Storage();
const bucket = storage.bucket(process.env.BUCKET_NAME);

const USER_LIMIT = Number(process.env.USER_LIMIT || process.env.LIMIT || 3);
const PGS_LIMIT = Number(process.env.PGS_LIMIT || 3);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 1);

const BASE_PATH = "prs_workflow";

async function saveJson(path, obj) {
  await bucket.file(path).save(JSON.stringify(obj, null, 2), {
    contentType: "application/json"
  });
}


//add explicit cache/checkpoint logs so each user/PGS model says either:
//USING EXISTING,FETCHING,SAVED,FAILED

async function fileExists(path) {
  const [exists] = await bucket.file(path).exists();
  return exists;
}

async function readJson(path) {
  const [contents] = await bucket.file(path).download();
  return JSON.parse(contents.toString("utf8"));
}

function normalizeLoaded23andMe(loaded) {
  if (!loaded) return { raw: null, parsed: null };

  if (typeof loaded === "string") {
    return {
      raw: loaded,
      parsed: null
    };
  }

  return {
    raw: loaded.txt ?? loaded.raw ?? null,
    parsed: loaded.dt ? loaded : loaded.parsed ?? loaded
  };
}

function normalizePGSTxt(pgsObj) {
  if (!pgsObj) return null;

  if (typeof pgsObj === "string") {
    return pgsObj;
  }

  return pgsObj;
}

async function runInBatches(items, batchSize, fn) {
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    console.log(`Starting batch ${i / batchSize + 1}`);

    const batchResults = await Promise.all(
      batch.map((item, j) => fn(item, i + j, items.length))
    );

    results.push(...batchResults);

    console.log(`Finished ${results.length}/${items.length}`);
  }

  return results;
}

async function loadOneUser(user, index, total) {
  const id = user.id;

  const profilePath = `${BASE_PATH}/pgp/profiles/${id}.json`;
  const parsedPath = `${BASE_PATH}/pgp/parsed_23andme/${id}.json`;
  const metadataPath = `${BASE_PATH}/pgp/metadata/${id}.json`;

  try {
    console.log(`Loading user ${index + 1}/${total}: ${id}`);

    const parsedExists = await fileExists(parsedPath);

    if (parsedExists) {
      console.log(`USING EXISTING 23andMe parsed file from bucket: ${id}`);

      const genotype = await readJson(parsedPath);

      return {
        id,
        user,
        profile: null,
        genotype,
        status: "existing"
      };
    }

    console.log(`FETCHING 23andMe file from PGP: ${id}`);

    const [profile, loaded23] = await Promise.all([
      fetchProfile(id),
      get23Txt(user.downloadUrl, id, false)
    ]);

    const { parsed } = normalizeLoaded23andMe(loaded23);

    await saveJson(profilePath, profile);
    await saveJson(metadataPath, user);
    await saveJson(parsedPath, parsed ?? loaded23);

    console.log(`SAVED new 23andMe parsed file: ${id}`);

    return {
      id,
      user,
      profile,
      genotype: parsed ?? loaded23,
      status: "success"
    };

  } catch (err) {
    console.error(`FAILED user ${id}: ${err.message}`);

    await saveJson(`${BASE_PATH}/errors/users/${id}.json`, {
      id,
      user,
      error: err.message,
      failedAt: new Date().toISOString()
    });

    return {
      id,
      user,
      profile: null,
      genotype: null,
      status: "failed",
      error: err.message
    };
  }
}
// async function loadOneUser(user, index, total) {
//   const id = user.id;

//   try {
//     console.log(`Loading user ${index + 1}/${total}: ${id}`);

//     const profilePath = `${BASE_PATH}/pgp/profiles/${id}.json`;
//     const parsedPath = `${BASE_PATH}/pgp/parsed_23andme/${id}.json`;
//     const metadataPath = `${BASE_PATH}/pgp/metadata/${id}.json`;

//     const [profile, loaded23] = await Promise.all([
//       fetchProfile(id),
//       get23Txt(user.downloadUrl, id, false)
//     ]);

//     const { parsed } = normalizeLoaded23andMe(loaded23);

//     await saveJson(profilePath, profile);
//     await saveJson(metadataPath, user);
//     await saveJson(parsedPath, parsed ?? loaded23);

//     console.log(`Saved user ${id}`);

//     return {
//       id,
//       user,
//       profile,
//       genotype: parsed ?? loaded23,
//       status: "success"
//     };

//   } catch (err) {
//     console.error(`Failed user ${id}: ${err.message}`);

//     await saveJson(`${BASE_PATH}/errors/users/${id}.json`, {
//       id,
//       user,
//       error: err.message,
//       failedAt: new Date().toISOString()
//     });

//     return {
//       id,
//       user,
//       profile: null,
//       genotype: null,
//       status: "failed",
//       error: err.message
//     };
//   }
// }

async function loadPgsModels() {
  console.log("Fetching PGS Catalog score metadata...");

const allScoresResult = await fetchAllScores();

if (allScoresResult?.errorMessage) {
  throw new Error(`fetchAllScores failed: ${allScoresResult.errorMessage}`);
}
console.log("fetchAllScores result type:", typeof allScoresResult);
console.log("fetchAllScores is array:", Array.isArray(allScoresResult));
console.log("fetchAllScores keys:", Object.keys(allScoresResult ?? {}));
console.log(
  "fetchAllScores preview:",
  JSON.stringify(allScoresResult, null, 2).slice(0, 1000)
);

const scores = Array.isArray(allScoresResult)
  ? allScoresResult
  : allScoresResult.scores ??
    allScoresResult.results ??
    allScoresResult.data ??
    allScoresResult.items ??
    [];

console.log(`Found ${scores.length} PGS models.`);

// await saveJson(`${BASE_PATH}/manifests/all_pgs_scores_metadata.json`, scores);
// Do not save all 5,000+ PGS metadata records for now.
// This keeps the ingestion job lighter and avoids failing right after fetchAllScores().
console.log("Skipping save of all_pgs_scores_metadata.json for this run.");

const MAX_VARIANTS = Number(process.env.MAX_VARIANTS || 1000);

console.log("Filtering PGS models by variant count...");

const filteredScores = scores.filter(score => {
  const nVariants = Number(score.variants_number);
  return Number.isFinite(nVariants) && nVariants < MAX_VARIANTS;
});

console.log(
  `Found ${filteredScores.length} PGS models with variants_number < ${MAX_VARIANTS}.`
);
console.log("Saving filtered PGS manifest...");

await saveJson(
  `${BASE_PATH}/manifests/pgs_scores_under_${MAX_VARIANTS}_variants.json`,
  filteredScores
);
console.log("Saved filtered PGS manifest.");

const selectedScores = filteredScores.slice(0, PGS_LIMIT);
const selectedIds = selectedScores.map(s => s.id);

console.log(`Preparing first ${selectedIds.length} PGS scoring files: ${selectedIds.join(", ")}`);

await saveJson(`${BASE_PATH}/manifests/selected_pgs_models.json`, selectedScores);

const models = [];

for (let i = 0; i < selectedIds.length; i++) {
  const id = selectedIds[i];
  const meta = selectedScores[i];

  const metaPath = `${BASE_PATH}/pgs/metadata/${id}.json`;
  const txtPath = `${BASE_PATH}/pgs/txt/${id}.json`;

  const txtExists = await fileExists(txtPath);

  if (txtExists) {
    console.log(`USING EXISTING PGS file from bucket: ${id}`);

    const txt = await readJson(txtPath);

    models.push({
      id,
      meta,
      txt: normalizePGSTxt(txt)
    });

    continue;
  }

  // check if pgs files are in bucket first
  console.log(`FETCHING PGS scoring file from PGS Catalog/EBI: ${id}`);

  try {
    const fetched = await getPgsTxt([id]);

    const txtObj = Array.isArray(fetched)
      ? fetched[0]
      : fetched[id] ?? fetched[0] ?? fetched;

    const normalizedTxt = normalizePGSTxt(txtObj);

    await saveJson(metaPath, meta);
    await saveJson(txtPath, normalizedTxt);

    console.log(`SAVED new PGS scoring file: ${id}`);

    models.push({
      id,
      meta,
      txt: normalizedTxt
    });

    // small pause to avoid hitting EBI too fast
    await new Promise(resolve => setTimeout(resolve, 1000));

  } catch (err) {
    console.error(`FAILED PGS ${id}: ${err.message}`);

    await saveJson(`${BASE_PATH}/errors/pgs/${id}.json`, {
      id,
      meta,
      error: err.message,
      failedAt: new Date().toISOString()
    });
  }
}

return models;
}
//   console.log(`Fetching first ${selectedIds.length} PGS scoring files: ${selectedIds.join(", ")}`);

//   const txts = await getPgsTxt(selectedIds);

//   await saveJson(`${BASE_PATH}/manifests/selected_pgs_models.json`, selectedScores);

//   const models = selectedIds.map((id, i) => {
//     let txtObj;

//     if (Array.isArray(txts)) {
//       txtObj = txts.find(x => x?.id === id) ?? txts[i];
//     } else {
//       txtObj = txts[id] ?? txts[i];
//     }

//     return {
//       id,
//       meta: selectedScores[i],
//       txt: normalizePGSTxt(txtObj)
//     };
//   });

//   for (const model of models) {
//     await saveJson(`${BASE_PATH}/pgs/metadata/${model.id}.json`, model.meta);
//     await saveJson(`${BASE_PATH}/pgs/txt/${model.id}.json`, model.txt);

//   }

//   return models;
// }

async function runPrsForPair({ userObj, pgsObj }) {
  const userId = userObj.id;
  const pgsId = pgsObj.id;

  const resultPath = `${BASE_PATH}/prs_results/${userId}/${pgsId}.json`;

  try {
    if (await fileExists(resultPath)) {
      console.log(`Skipping existing PRS result: ${userId} × ${pgsId}`);
      return {
        userId,
        pgsId,
        status: "skipped"
      };
    }

    console.log(`Running PRS: ${userId} × ${pgsId}`);

    const result = await Match2(pgsObj.txt, userObj.genotype);

    await saveJson(resultPath, {
      userId,
      pgsId,
      pgsName: pgsObj.meta?.name ?? null,
      trait: pgsObj.meta?.trait_reported ?? null,
      result
    });

    return {
      userId,
      pgsId,
      status: "success"
    };

  } catch (err) {
    console.error(`Failed PRS ${userId} × ${pgsId}: ${err.message}`);

    await saveJson(`${BASE_PATH}/errors/prs/${userId}_${pgsId}.json`, {
      userId,
      pgsId,
      error: err.message,
      failedAt: new Date().toISOString()
    });

    return {
      userId,
      pgsId,
      status: "failed",
      error: err.message
    };
  }
}

async function main() {
  console.log("Starting PRS Cloud Run workflow...");

  if (!process.env.BUCKET_NAME) {
    throw new Error("Missing required environment variable: BUCKET_NAME");
  }

  console.log("Checking available PGP data types...");
  const dataTypes = await fetchAvailableDataTypes();
  await saveJson(`${BASE_PATH}/manifests/available_data_types.json`, dataTypes);

  console.log("Fetching 23andMe user metadata...");
  let users = await allUsersMetaDataByType_fast("23andMe");

  console.log(`Found ${users.length} 23andMe users.`);

  await saveJson(`${BASE_PATH}/manifests/all_23andme_metadata.json`, users);

  if (USER_LIMIT > 0) {
    users = users.slice(0, USER_LIMIT);
    console.log(`USER_LIMIT=${USER_LIMIT}; processing first ${users.length} users.`);
  }

  const loadedUsers = await runInBatches(users, BATCH_SIZE, loadOneUser);
  const validUsers = loadedUsers.filter(u => u.status === "success" && u.genotype);

  console.log(`Loaded ${validUsers.length}/${users.length} users successfully.`);

  const pgsModels = await loadPgsModels();

//   const pairs = [];

//   for (const userObj of validUsers) {
//     for (const pgsObj of pgsModels) {
//       pairs.push({ userObj, pgsObj });
//     }
//   }

//   console.log(`Running ${pairs.length} PRS comparisons.`);

//   const prsResults = await runInBatches(
//     pairs,
//     BATCH_SIZE,
//     async pair => runPrsForPair(pair)
//   );

const prsResults = [];

console.log("Skipping PRS computation for this run. Ingestion only.");

//   await saveJson(`${BASE_PATH}/manifests/import_and_prs_results.json`, {
//     userLimit: USER_LIMIT,
//     pgsLimit: PGS_LIMIT,
//     totalUsersRequested: users.length,
//     totalUsersLoaded: validUsers.length,
//     totalPgsModels: pgsModels.length,
//     totalPrsRuns: prsResults.length,
//     success: prsResults.filter(r => r.status === "success").length,
//     skipped: prsResults.filter(r => r.status === "skipped").length,
//     failed: prsResults.filter(r => r.status === "failed").length,
//     prsResults,
//     completedAt: new Date().toISOString()
//   });
await saveJson(`${BASE_PATH}/manifests/import_and_prs_results.json`, {
  mode: "ingestion_only",
  userLimit: USER_LIMIT,
  pgsLimit: PGS_LIMIT,
  totalUsersRequested: users.length,
  totalUsersLoaded: validUsers.length,
  totalPgsModels: pgsModels.length,
  totalPrsRuns: 0,
  success: 0,
  skipped: 0,
  failed: 0,
  prsResults,
  completedAt: new Date().toISOString()
});

  console.log("PRS Cloud Run workflow complete.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
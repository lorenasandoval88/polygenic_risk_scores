import * as clust from "../sdk/clustSdk.js";

// clust.js adds the Cluster Analysis tab for your PRS app and does four main things:

// 1. PRS-level clustering
// Converts PRS results into a user × PGS matrix.
// Rows = users.
// Columns = PGS entries.
// Values = PRS scores.
// Clusters users and/or PGS entries.

// 2. Allele clustering for one selected PGS
// Builds user × SNP matrices.
// Rows = users.
// Columns = variants.
// Values = allele counts 0, 1, 2.
// Supports three views:
// all variants
// overlapping variants matched in at least one user
// shared variants matched in all users
// Missing variants are displayed separately, often as -1/black.

// 3. PGS vs SNP clustering for one selected user
// Builds PGS × SNP matrices.
// Rows = PGS entries.
// Columns = SNPs.
// Values = allele counts for that user.
// Useful for comparing how multiple PGS entries overlap in the same person.

// 4. PGS × SNP effect-weight clustering
// Builds matrices from PGS scoring-file effect weights.
// Rows = PGS entries.
// Columns = SNPs.
// Values = effect_weight, z-scored by row.
// This compares PGS entries biologically by their SNP effect profiles.

// It also includes:

// a caching system to avoid recomputing matrices every time the tab rerenders
// dropdowns for selecting PGS ID or user
// buttons for row/column clustering
// linkage choices: complete, single, average, ward
// distance choices: euclidean, manhattan, cosine
// D3 color scales for allele counts and effect weights
// calls to clust.hclust_plot() to render heatmap + dendrogram plots

const clusterContainerId = "clusterDiv";

// Caching mechanism to avoid redundant computations
// This is not persistent - it only lasts for the current browser session
let clusterCache = {
  prsResultsHash: null,      // Hash of prsResults to detect changes
  selectedPgsId: null,       // Last selected PGS ID
  selectedUserId: null,      // Last selected user ID
  pivoted: null,
  pgsIds: null,
  userIds: null,
  alleleMatrices: null,      // Cached allele matrices for selected PGS
  pgsVsSnpsMatrices: null,   // Cached PGS vs SNPs matrices for selected user
  effectMatrices: null,      // Cached effect weight matrices
  snpLists: null,            // Cached SNP lists
  rawGenoMatrix: null,       // Cached Section F raw genotype matrix
};

/**
 * Generate a simple hash of prsResults to detect changes
 */
function hashPrsResults(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  // Use length + sum of PRS values as a quick hash
  let hash = results.length;
  for (const r of results) {
    if (r.PRS != null && Number.isFinite(r.PRS)) {
      hash += r.PRS;
    }
  }
  return `${hash}-${results.length}`;
}

/**
 * Check if cache is valid for current data
 */
function isCacheValid(currentHash, selectedPgsId, selectedUserId) {
  return clusterCache.prsResultsHash === currentHash && 
         clusterCache.pivoted !== null;
}

/**
 * Invalidate the cluster cache (call when data changes)
 */
function invalidateClusterCache() {
  clusterCache = {
    prsResultsHash: null,
    selectedPgsId: null,
    selectedUserId: null,
    pivoted: null,
    pgsIds: null,
    userIds: null,
    alleleMatrices: null,
    pgsVsSnpsMatrices: null,
    effectMatrices: null,
    snpLists: null,
    rawGenoMatrix: null,
  };
  // console.log("Cluster cache invalidated");
}

// Expose cache invalidation globally so it can be called when PRS is recalculated
window.invalidateClusterCache = invalidateClusterCache;

// Expose cluster cache via getter so AI Interpret tab can summarize clustering results.
// Uses a getter because invalidateClusterCache() reassigns the clusterCache variable.
window.getClusterCache = () => clusterCache;


/**
 * Pivot window.prsResults (flat array of {userId, pgsId, PRS}) into
 * one object per user where each key is a pgsId and the value is PRS.
 * Returns null if no usable results exist.
 */
function pivotPrsResults(rawResults) {
  if (!Array.isArray(rawResults) || rawResults.length === 0) return null;

  const byUser = new Map();
  for (const r of rawResults) {
    if (!r.userId || r.PRS == null || !Number.isFinite(r.PRS)) continue;
    if (!byUser.has(r.userId)) {
      byUser.set(r.userId, { label: r.userName ?? r.userId });
    }
    byUser.get(r.userId)[r.pgsId] = r.PRS;
  }

  const rows = Array.from(byUser.values());
  return rows.length >= 2 ? rows : null;
}

/**
 * Get unique PGS IDs from prsResults
 */
function getUniquePgsIds(rawResults) {
  if (!Array.isArray(rawResults)) return [];
  const ids = new Set();
  for (const r of rawResults) {
    if (r.pgsId) ids.add(r.pgsId);
  }
  return Array.from(ids);
}

/**
 * Get total variant count for a PGS ID
 */
function getTotalVariants(rawResults, pgsId) {
  const result = rawResults?.find(r => r.pgsId === pgsId);
  return result?.pgs?.dt?.length ?? 0;
}

/**
 * Get publication year for a PGS ID from citation metadata
 */
function getPublicationYear(rawResults, pgsId) {
  const result = rawResults?.find(r => r.pgsId === pgsId);
  const citation = result?.pgs?.meta?.citation ?? '';
  // Extract year from citation format "Author et al. Journal (YYYY). doi:..."
  const match = citation.match(/\((\d{4})\)/);
  return match ? match[1] : '';
}

/**
 * Build matched vs unmatched beta contribution per user for a selected PGS.
 * Uses organized risk arrays when available, with fallback to legacy fields.
 */
function getBetaContributionByUser(rawResults, targetPgsId) {
  if (!Array.isArray(rawResults) || !targetPgsId) return [];

  const sumFinite = (arr) => (Array.isArray(arr)
    ? arr.reduce((acc, v) => acc + (Number.isFinite(Number(v)) ? Number(v) : 0), 0)
    : 0);

  const out = [];

  for (const result of rawResults) {
    if (result?.pgsId !== targetPgsId) continue;

    const userLabel = result.userName ?? result.userId ?? 'Unknown';
    const userId = result.userId ?? userLabel;

    const organizedMatchedRisk = result.organized?.matched?.risk;
    const organizedUnmatchedRisk = result.organized?.not_matched?.risk;

    if (Array.isArray(organizedMatchedRisk) || Array.isArray(organizedUnmatchedRisk)) {
      out.push({
        userId,
        userLabel,
        matchedBeta: sumFinite(organizedMatchedRisk),
        unmatchedBeta: sumFinite(organizedUnmatchedRisk),
        matchedCount: Array.isArray(organizedMatchedRisk) ? organizedMatchedRisk.length : 0,
        unmatchedCount: Array.isArray(organizedUnmatchedRisk) ? organizedUnmatchedRisk.length : 0,
      });
      continue;
    }

    const pgsData = result.pgs;
    const indWeight = pgsData?.cols?.indexOf('effect_weight') ?? -1;
    if (!pgsData?.dt || indWeight < 0) continue;

    const matchedVariants = Array.isArray(result.pgsMatchMy23)
      ? result.pgsMatchMy23
          .map(m => (Array.isArray(m) && m.length >= 2 ? m[m.length - 1] : null))
          .filter(Boolean)
      : [];

    const matchedSet = new Set(matchedVariants);
    const notMatchedVariants = pgsData.dt.filter(v => !matchedSet.has(v));

    out.push({
      userId,
      userLabel,
      matchedBeta: sumFinite(matchedVariants.map(v => v[indWeight])),
      unmatchedBeta: sumFinite(notMatchedVariants.map(v => v[indWeight])),
      matchedCount: matchedVariants.length,
      unmatchedCount: notMatchedVariants.length,
    });
  }

  return out;
}

/**
 * Compute allele-sharing distance between two genotypes at a single locus.
 * Genotypes are strings like "AA", "AT", "GG", etc. (2 characters).
 * Distance is based on number of alleles shared:
 *   2 alleles shared (both same) = distance 0
 *   1 allele shared = distance 1
 *   0 alleles shared = distance 2
 * 
 * Correctly handles homozygotes by counting allele frequencies:
 * Example: AA vs AT → A appears in both (min(2,1)=1 shared) → distance 1
 * 
 * @param {string} geno1 - First genotype (e.g., "AA")
 * @param {string} geno2 - Second genotype (e.g., "AT")
 * @returns {number} Allele-sharing distance (0, 1, or 2), or NaN if invalid
 */
function alleleSharingDistance(geno1, geno2) {
  if (typeof geno1 !== 'string' || typeof geno2 !== 'string') return NaN;
  if (geno1.length !== 2 || geno2.length !== 2) return NaN;

  // Count allele frequencies in each genotype
  const count1 = {};
  const count2 = {};
  
  for (const a of geno1.split('')) {
    count1[a] = (count1[a] || 0) + 1;
  }
  
  for (const a of geno2.split('')) {
    count2[a] = (count2[a] || 0) + 1;
  }
  
  // Count shared alleles by frequency matching
  // For each unique allele, add min(frequency in geno1, frequency in geno2)
  let sharedCount = 0;
  const allUnique = new Set([...Object.keys(count1), ...Object.keys(count2)]);
  
  for (const allele of allUnique) {
    const c1 = count1[allele] || 0;
    const c2 = count2[allele] || 0;
    sharedCount += Math.min(c1, c2);
  }
  
  // Distance = 2 - sharedCount
  return 2 - sharedCount;
}

/**
 * Build user × SNP allele count matrix across all PGS entries combined.
 * Rows = users, Columns = SNPs shared across ALL users.
 * Values = encoded genotypes (0–9). Used for genotype-level clustering in section E.
 * @param {Array} rawResults - window.prsResults
 * @returns {Object|null} { matrix, userIds, snpCount }
 */

/**
 * Encode a diploid genotype string (e.g. "AT") to a canonical integer (0–9).
/**
 * Serialise a hclust_plot matrix (array of row-objects with a `label` key) to CSV
 * and trigger a browser download.
 * @param {Array<Object>} matrix - e.g. [{label:'user1', rs123: 0, rs456: 7, ...}, ...]
 * @param {string} filename     - suggested download filename
 */
function downloadMatrixAsCsv(matrix, filename = 'matrix.csv') {
  if (!Array.isArray(matrix) || matrix.length === 0) return;
  const cols = Object.keys(matrix[0]).filter(k => k !== 'label');
  const header = ['label', ...cols].join(',');
  const rows = matrix.map(row =>
    [row.label, ...cols.map(c => row[c] ?? '')].join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Encode a diploid genotype string (e.g. "AT") to a canonical integer (0–9).
 * Alleles are sorted before lookup so AT === TA.
 * Returns -1 for unknown or missing genotypes.
 */
function encodeGenotype(genotype) {
  if (typeof genotype !== 'string' || genotype.length !== 2) return -1;
  const g = genotype.split('').sort().join('');
  const map = { AA: 0, AC: 1, AG: 2, AT: 3, CC: 4, CG: 5, CT: 6, GG: 7, GT: 8, TT: 9 };
  return map[g] ?? -1;
}

/**
 * Build user × SNP matrix of encoded raw genotypes (not just allele counts).
 * @param {Array} rawResults - window.prsResults
 * @param {Object} options - { mode: 'shared'|'overlapping', missingValue: -1 }
 * @returns {Object|null} { matrix, userIds, snpCount }
 */
function buildUserSnpGenotypeMatrix(rawResults, { mode = 'shared', missingValue = -1 } = {}) {
  if (!Array.isArray(rawResults) || rawResults.length === 0) return null;

  const userDataMap = new Map();

  for (const result of rawResults) {
    if (!result.userId) continue;

    const userId = result.userId;
    const userLabel = result.userName ?? result.userId;
    if (!userDataMap.has(userId)) {
      userDataMap.set(userId, { label: userLabel, genotypes: new Map() });
    }
    const userData = userDataMap.get(userId);

    // Preferred: result.results (expanded result structure)
    if (Array.isArray(result.results)) {
      for (const item of result.results) {
        if (item.match !== true) continue;
        const snpId = item.hm_chr_pos;
        const genotype = item.my23?.[0]?.[3];
        if (!snpId) continue;
        if (typeof genotype === 'string' && genotype.length === 2) {
          userData.genotypes.set(snpId, encodeGenotype(genotype));
        }
      }
      continue;
    }

    // Fallback: legacy pgsMatchMy23
    if (Array.isArray(result.pgsMatchMy23) && result.pgs?.cols) {
      const indChr = result.pgs.cols.indexOf('hm_chr');
      const indPos = result.pgs.cols.indexOf('hm_pos');
      const indRsid = result.pgs.cols.indexOf('rsID');

      for (const matchModel of result.pgsMatchMy23) {
        if (!Array.isArray(matchModel) || matchModel.length < 2) continue;
        const my23 = matchModel[0];
        const pgsVariant = matchModel[matchModel.length - 1];
        if (!Array.isArray(my23) || !Array.isArray(pgsVariant)) continue;

        let snpId = null;
        if (indChr >= 0 && indPos >= 0) snpId = `${pgsVariant[indChr]}:${pgsVariant[indPos]}`;
        else if (indRsid >= 0 && pgsVariant[indRsid]) snpId = pgsVariant[indRsid];

        const genotype = my23[3];
        if (snpId && typeof genotype === 'string' && genotype.length === 2) {
          userData.genotypes.set(snpId, encodeGenotype(genotype));
        }
      }
    }
  }

  if (userDataMap.size < 2) return null;

  let snpSet = null;
  if (mode === 'shared') {
    for (const ud of userDataMap.values()) {
      const s = new Set(ud.genotypes.keys());
      snpSet = snpSet === null ? s : new Set([...snpSet].filter(k => s.has(k)));
    }
  } else {
    snpSet = new Set();
    for (const ud of userDataMap.values()) for (const snp of ud.genotypes.keys()) snpSet.add(snp);
  }

  if (!snpSet || snpSet.size === 0) return null;

  const snpList = Array.from(snpSet);
  const userIds = Array.from(userDataMap.keys());

  const matrix = userIds.map(userId => {
    const ud = userDataMap.get(userId);
    const row = { label: ud.label };
    for (const snp of snpList) row[snp] = ud.genotypes.has(snp) ? ud.genotypes.get(snp) : missingValue;
    return row;
  });

  return { matrix, userIds, snpCount: snpList.length };
}

/** @deprecated */
function buildGenotypeAlleleMatrix(rawResults) {
  if (!Array.isArray(rawResults) || rawResults.length === 0) return null;

  const userDataMap = new Map(); // userId -> { label, alleles: {snpId -> count} }

  for (const result of rawResults) {
    if (!result.userId) continue;

    const userId = result.userId;
    const userLabel = result.userName ?? result.userId;
    if (!userDataMap.has(userId)) {
      userDataMap.set(userId, { label: userLabel, alleles: {} });
    }

    const userData = userDataMap.get(userId);
    const pgsData = result.pgs;
    if (!pgsData || !pgsData.cols) continue;

    const indChr = pgsData.cols.indexOf('hm_chr');
    const indPos = pgsData.cols.indexOf('hm_pos');
    const indRsid = pgsData.cols.indexOf('rsID');
    const getSnpId = (v) => {
      if (indRsid >= 0 && v[indRsid]) return v[indRsid];
      if (indChr >= 0 && indPos >= 0) return `${v[indChr]}:${v[indPos]}`;
      return null;
    };

    // Primary: organized.matched
    const org = result.organized?.matched;
    if (Array.isArray(org?.dt) && Array.isArray(org?.alleles)) {
      org.dt.forEach((pgsVariant, idx) => {
        if (!Array.isArray(pgsVariant)) return;
        const snpId = getSnpId(pgsVariant);
        if (!snpId) return;
        const a = Number(org.alleles[idx]);
        if (Number.isFinite(a)) userData.alleles[snpId] = a;
      });
    } else if (Array.isArray(result.pgsMatchMy23) && Array.isArray(result.alleles)) {
      // Fallback: legacy pgsMatchMy23
      result.pgsMatchMy23.forEach((matchModel, idx) => {
        const pgsVariant = matchModel[matchModel.length - 1];
        if (!Array.isArray(pgsVariant)) return;
        const snpId = getSnpId(pgsVariant);
        if (!snpId) return;
        const a = Number(result.alleles[idx]);
        if (Number.isFinite(a)) userData.alleles[snpId] = a;
      });
    }
  }

  if (userDataMap.size < 2) return null;

  // SNPs present in ALL users
  let sharedSnps = null;
  for (const ud of userDataMap.values()) {
    const s = new Set(Object.keys(ud.alleles));
    sharedSnps = sharedSnps === null ? s : new Set([...sharedSnps].filter(k => s.has(k)));
  }
  if (!sharedSnps || sharedSnps.size === 0) return null;

  const snpList = Array.from(sharedSnps);
  const userIds = Array.from(userDataMap.keys());

  const matrix = userIds.map(userId => {
    const ud = userDataMap.get(userId);
    const row = { label: ud.label };
    for (const snpId of snpList) row[snpId] = ud.alleles[snpId] ?? 0;
    return row;
  });

  return { matrix, userIds, snpCount: sharedSnps.size };
}

/** @deprecated */
function buildGenotypeDistanceMatrix(rawResults) {
  if (!Array.isArray(rawResults) || rawResults.length === 0) return null;

  // Step 1: Organize users and their genotype data across all matched SNPs
  const userDataMap = new Map(); // userId -> { label, genotypes: {snpId -> geno} }
  
  for (const result of rawResults) {
    if (!result.userId || !result.pgsMatchMy23) continue;

    const userId = result.userId;
    const userLabel = result.userName ?? result.userId;
    
    if (!userDataMap.has(userId)) {
      userDataMap.set(userId, { label: userLabel, genotypes: {} });
    }

    const userData = userDataMap.get(userId);
    const pgsData = result.pgs;
    if (!pgsData || !pgsData.cols) continue;

    const indChr = pgsData.cols.indexOf('hm_chr');
    const indPos = pgsData.cols.indexOf('hm_pos');
    const indRsid = pgsData.cols.indexOf('rsID');

    // Extract genotypes from pgsMatchMy23
    // Each element is [23andMe variant(s), ..., PGS variant]
    // The 23andMe data has genotype at the genotype column index
    result.pgsMatchMy23.forEach((matchModel) => {
      if (!Array.isArray(matchModel) || matchModel.length < 2) return;

      // Get PGS variant (last element)
      const pgsVariant = matchModel[matchModel.length - 1];
      if (!Array.isArray(pgsVariant)) return;

      // Create SNP identifier
      let snpId;
      if (indRsid >= 0 && pgsVariant[indRsid]) {
        snpId = pgsVariant[indRsid];
      } else if (indChr >= 0 && indPos >= 0) {
        snpId = `${pgsVariant[indChr]}:${pgsVariant[indPos]}`;
      } else {
        return;
      }

      // Get genotype from 23andMe variant (first element(s))
      // The 23andMe data has genotype column at a fixed index: typically index 3
      const my23Variants = matchModel.slice(0, -1); // All but last
      if (my23Variants.length === 0) return;
      
      const my23Variant = my23Variants[0]; // Use first matching 23andMe variant
      if (!Array.isArray(my23Variant)) return;

      // Find genotype column in 23andMe data
      // Standard 23andMe format: ['rsid', 'chromosome', 'position', 'genotype']
      const genotypeIdx = 3; // genotype is typically 4th column (0-indexed 3)
      const genotype = my23Variant[genotypeIdx];

      if (typeof genotype === 'string' && genotype.length === 2) {
        userData.genotypes[snpId] = genotype;
      }
    });
  }

  if (userDataMap.size < 2) return null;

  // Step 2: Find SNPs that are shared across all users
  let sharedSnps = null;
  for (const userData of userDataMap.values()) {
    const userSnpSet = new Set(Object.keys(userData.genotypes));
    if (sharedSnps === null) {
      sharedSnps = userSnpSet;
    } else {
      sharedSnps = new Set([...sharedSnps].filter(snp => userSnpSet.has(snp)));
    }
  }

  if (!sharedSnps || sharedSnps.size === 0) return null;

  // Step 3: Build distance matrix
  const userIds = Array.from(userDataMap.keys());
  const n = userIds.length;
  const distanceMatrix = Array(n).fill(null).map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const user1Data = userDataMap.get(userIds[i]);
      const user2Data = userDataMap.get(userIds[j]);

      let totalDistance = 0;
      let validSnpCount = 0;

      for (const snpId of sharedSnps) {
        const geno1 = user1Data.genotypes[snpId];
        const geno2 = user2Data.genotypes[snpId];

        if (geno1 && geno2) {
          const dist = alleleSharingDistance(geno1, geno2);
          if (Number.isFinite(dist)) {
            totalDistance += dist;
            validSnpCount++;
          }
        }
      }

      const avgDistance = validSnpCount > 0 ? totalDistance / validSnpCount : 0;
      distanceMatrix[i][j] = avgDistance;
      distanceMatrix[j][i] = avgDistance;
    }
  }

  return { userIds, distanceMatrix, sharedSnpCount: sharedSnps.size };
}

/**
 * Build user × SNP encoded-genotype matrix directly from raw 23andMe parsed files.
 * No PGS model used. Source = window.loadedUsers[].parsed (cols + dt).
 * @param {Array} loadedUsers - window.loadedUsers: [{user:{id,name}, parsed:{cols,dt}}]
 * @param {number} missingValue - Fill value for SNPs absent in a user (default -1)
 * @param {number} maxSnps     - Max SNP columns to include; evenly samples if exceeded (default 5000)
 * @returns {Object|null} { matrix, userIds, snpCount, totalSharedSnps }
 */
function buildRawGenotypeMatrix(loadedUsers, { missingValue = -1, maxSnps = 5000 } = {}) {
  if (!Array.isArray(loadedUsers) || loadedUsers.length < 2) return null;

  const userDataMap = new Map(); // userId -> { label, genotypes: Map<snpId, encodedInt> }

  for (const entry of loadedUsers) {
    const userId = entry.user?.id ?? entry.user?.participant_id;
    const userLabel = (entry.user?.dataSource === 'file Upload' && entry.user?.fileName)
      ? entry.user.fileName
      : (entry.user?.name ?? userId);
    const parsed = entry.parsed;
    if (!userId || !parsed?.cols || !Array.isArray(parsed.dt)) {
      console.warn('[F] Skipping user — missing parsed data:', userId, { hasCols: !!parsed?.cols, hasDt: Array.isArray(parsed?.dt) });
      continue;
    }

    const indRsid = parsed.cols.indexOf('rsid');
    const indChr  = parsed.cols.indexOf('chromosome');
    const indPos  = parsed.cols.indexOf('position');
    const indGeno = parsed.cols.indexOf('genotype');
    if (indGeno < 0) continue;

    const genotypes = new Map();
    for (const row of parsed.dt) {
      const geno = row[indGeno];
      if (typeof geno !== 'string' || geno.length !== 2) continue;
      // Use rsid if available, else chr:pos
      const snpId = (indRsid >= 0 && row[indRsid])
        ? row[indRsid]
        : (indChr >= 0 && indPos >= 0 ? `${row[indChr]}:${row[indPos]}` : null);
      if (snpId) genotypes.set(snpId, encodeGenotype(geno));
    }
    userDataMap.set(userId, { label: userLabel, genotypes });
  }

  console.log(`[F] buildRawGenotypeMatrix: ${userDataMap.size} of ${loadedUsers.length} users passed parse check`, Array.from(userDataMap.keys()));
  if (userDataMap.size < 2) return null;

  // Find SNPs present in ALL users
  let sharedSnps = null;
  for (const ud of userDataMap.values()) {
    const s = new Set(ud.genotypes.keys());
    sharedSnps = sharedSnps === null ? s : new Set([...sharedSnps].filter(k => s.has(k)));
  }
  if (!sharedSnps || sharedSnps.size === 0) return null;

  const totalSharedSnps = sharedSnps.size;
  let snpList = Array.from(sharedSnps);

  // Evenly subsample if too many SNPs to avoid OOM
  if (snpList.length > maxSnps) {
    const step = snpList.length / maxSnps;
    snpList = Array.from({ length: maxSnps }, (_, i) => snpList[Math.round(i * step)]);
  }

  const userIds = Array.from(userDataMap.keys());

  const matrix = userIds.map(userId => {
    const ud = userDataMap.get(userId);
    const row = { label: ud.label };
    for (const snp of snpList) row[snp] = ud.genotypes.has(snp) ? ud.genotypes.get(snp) : missingValue;
    return row;
  });

  return { matrix, userIds, snpCount: snpList.length, totalSharedSnps };
}

 /* Each row is a user, each column is a variant (rsid or chr:pos).
 * Values can be allele counts (0,1,2) or risk_x_allele.
 * For non-matches, uses missingValue as a marker.
 * Returns array of objects suitable for hclust_plot: [{label, variant1: alleleCount, variant2: alleleCount, ...}, ...]
 * @param {string} mode - "all" (all PGS variants), "overlapping" (matched in ≥1 user), "shared" (matched in ALL users)
 * @param {number} missingValue - Value to use for missing/non-matched variants (default: -1)
 */
function buildAlleleMatrix(rawResults, targetPgsId, { mode = 'overlapping', missingValue = -1, valueMode = 'allele' } = {}) {
  if (!Array.isArray(rawResults) || rawResults.length === 0) return null;

  // First pass: collect all user data and per-user matched variants
  const usersData = [];
  let pgsDataRef = null;

  for (const result of rawResults) {
    if (result.pgsId !== targetPgsId) continue;

    const label = result.userName ?? result.userId ?? 'Unknown';
    const pgsData = result.pgs;
    if (!pgsData || !pgsData.cols) continue;

    pgsDataRef = pgsDataRef || pgsData;

    const indChr = pgsData.cols.indexOf('hm_chr');
    const indPos = pgsData.cols.indexOf('hm_pos');
    const indRsid = pgsData.cols.indexOf('rsID');
    const indWeight = pgsData.cols.indexOf('effect_weight');

    const getVariantId = (variant, idx) => {
      if (indRsid >= 0 && variant[indRsid]) return variant[indRsid];
      if (indChr >= 0 && indPos >= 0) return `${variant[indChr]}:${variant[indPos]}`;
      return `var_${idx}`;
    };

    const matchedVariants = new Map(); // variantId -> alleleCount

    const calcValue = (pgsVariant, alleleRaw, riskRaw, riskXRaw) => {
      const allele = Number(alleleRaw);
      const risk = Number(riskRaw);
      const riskX = Number(riskXRaw);
      if (valueMode === 'risk_x_allele') {
        if (Number.isFinite(riskX)) return riskX;
        if (Number.isFinite(risk) && Number.isFinite(allele)) return risk * allele;
        if (indWeight >= 0 && Array.isArray(pgsVariant)) {
          const beta = Number(pgsVariant[indWeight]);
          if (Number.isFinite(beta) && Number.isFinite(allele)) return beta * allele;
        }
        return missingValue;
      }
      return Number.isFinite(allele) ? allele : missingValue;
    };

    // Primary source: organized.matched (from calculatePrs.js)
    const organizedMatched = result.organized?.matched;
    const organizedMatchedDt = organizedMatched?.dt;
    const organizedAlleles = organizedMatched?.alleles;
    const organizedRisk = organizedMatched?.risk;
    const organizedRiskXAllele = organizedMatched?.risk_x_allele;
    if (Array.isArray(organizedMatchedDt) && Array.isArray(organizedAlleles)) {
      organizedMatchedDt.forEach((pgsVariant, idx) => {
        if (!Array.isArray(pgsVariant)) return;
        const variantId = getVariantId(pgsVariant, idx);
        const value = calcValue(pgsVariant, organizedAlleles[idx], organizedRisk?.[idx], organizedRiskXAllele?.[idx]);
        matchedVariants.set(variantId, value);
      });
    } else if (Array.isArray(result.pgsMatchMy23) && Array.isArray(result.alleles)) {
      // Fallback source: legacy Match2 fields
      result.pgsMatchMy23.forEach((matchModel, idx) => {
        const pgsVariant = matchModel.length >= 2 ? matchModel[matchModel.length - 1] : null;
        if (!pgsVariant) return;

        const variantId = getVariantId(pgsVariant, idx);
        const value = calcValue(pgsVariant, result.alleles[idx], undefined, undefined);
        matchedVariants.set(variantId, value);
      });
    }

    usersData.push({ label, matchedVariants, pgsData, getVariantId });
  }

  if (usersData.length < 2) return null;

  // Determine which variants to include based on mode
  let targetVariants;

  if (mode === 'all') {
    // All variants in PGS file
    targetVariants = new Set();
    if (pgsDataRef?.dt) {
      const indChr = pgsDataRef.cols.indexOf('hm_chr');
      const indPos = pgsDataRef.cols.indexOf('hm_pos');
      const indRsid = pgsDataRef.cols.indexOf('rsID');
      pgsDataRef.dt.forEach((variant, idx) => {
        if (indRsid >= 0 && variant[indRsid]) {
          targetVariants.add(variant[indRsid]);
        } else if (indChr >= 0 && indPos >= 0) {
          targetVariants.add(`${variant[indChr]}:${variant[indPos]}`);
        } else {
          targetVariants.add(`var_${idx}`);
        }
      });
    }
  } else if (mode === 'shared') {
    // Only variants matched in ALL users
    targetVariants = null;
    for (const user of usersData) {
      const userVariants = new Set(user.matchedVariants.keys());
      if (targetVariants === null) {
        targetVariants = userVariants;
      } else {
        targetVariants = new Set([...targetVariants].filter(v => userVariants.has(v)));
      }
    }
    targetVariants = targetVariants || new Set();
  } else {
    // 'overlapping' - variants matched in at least one user (union)
    targetVariants = new Set();
    for (const user of usersData) {
      for (const v of user.matchedVariants.keys()) {
        targetVariants.add(v);
      }
    }
  }

  if (targetVariants.size === 0) return null;

  // Build final matrix
  const allVariants = Array.from(targetVariants);
  const userVariantMap = usersData.map(user => {
    const row = { label: user.label };
    for (const v of allVariants) {
      row[v] = user.matchedVariants.has(v) ? user.matchedVariants.get(v) : missingValue;
    }
    return row;
  });

  // console.log(`buildAlleleMatrix (${mode}):`, userVariantMap.length, "users,", allVariants.length, "variants, missingValue:", missingValue);

  return userVariantMap;
}

/**
 * Get unique user IDs from prsResults
 */
function getUniqueUserIds(rawResults) {
  if (!Array.isArray(rawResults)) return [];
  const users = new Map();
  for (const r of rawResults) {
    if (r.userId && !users.has(r.userId)) {
      users.set(r.userId, r.userName ?? r.userId);
    }
  }
  return Array.from(users.entries()).map(([id, name]) => ({ id, name }));
}

/**
 * Build matrix for clustering PGS entries (rows) by SNPs (columns) for a single user.
 * Each row is a PGS model, each column is a SNP (rsid or chr:pos), values are allele counts.
 * @param {Array} rawResults - window.prsResults
 * @param {string} targetUserId - The user ID to filter by
 * @param {Object} options - { missingValue: -1, mode: 'all' }
 * @param {string} mode - "all" (union of SNPs), "overlapping" (in ≥2 PGS), "shared" (in ALL PGS)
 */
function buildPgsVsSnpsMatrix(rawResults, targetUserId, { missingValue = -1, mode = 'all' } = {}) {
  const userResults = rawResults.filter(r => r.userId === targetUserId);

  if (!userResults.length || userResults.length < 2) return null;

  // First pass: collect SNPs per PGS model and count occurrences
  const snpCounts = new Map(); // snpId -> count of PGS entries containing it
  const pgsSnpMaps = new Map(); // pgsId -> snpMap: Map<snpId, alleleCount> (deduplicated)

  for (const r of userResults) {
    if (!r.pgsMatchMy23 || !r.pgs?.cols) continue;
    if (pgsSnpMaps.has(r.pgsId)) continue; // Skip duplicates

    const pgsData = r.pgs;
    const indChr = pgsData.cols.indexOf('hm_chr');
    const indPos = pgsData.cols.indexOf('hm_pos');
    const indRsid = pgsData.cols.indexOf('rsID');

    const snpMap = new Map();
    const seenSnps = new Set();

    r.pgsMatchMy23.forEach((matchModel, idx) => {
      const pgsVariant = matchModel.length >= 2 ? matchModel[matchModel.length - 1] : null;
      if (!pgsVariant) return;

      let snpId;
      if (indRsid >= 0 && pgsVariant[indRsid]) {
        snpId = pgsVariant[indRsid];
      } else if (indChr >= 0 && indPos >= 0) {
        snpId = `${pgsVariant[indChr]}:${pgsVariant[indPos]}`;
      } else {
        snpId = `var_${idx}`;
      }

      const val = r.alleles ? Number(r.alleles[idx]) : missingValue;
      snpMap.set(snpId, Number.isFinite(val) ? val : missingValue);

      if (!seenSnps.has(snpId)) {
        seenSnps.add(snpId);
        snpCounts.set(snpId, (snpCounts.get(snpId) || 0) + 1);
      }
    });

    pgsSnpMaps.set(r.pgsId, snpMap);
    //console.log(`Processed PGS ${r.pgsId} for user ${targetUserId}: ${snpMap.size} SNPs matched.`);
  }

  if (pgsSnpMaps.size < 2) return null;

  // Determine which SNPs to include based on mode
  const numPgs = pgsSnpMaps.size;
  let targetSnps;

  if (mode === 'shared') {
    // SNPs in ALL PGS entries
    targetSnps = [...snpCounts.entries()]
      .filter(([, count]) => count === numPgs)
      .map(([snp]) => snp);
  } else if (mode === 'overlapping') {
    // SNPs in ≥2 PGS entries
    targetSnps = [...snpCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([snp]) => snp);
  } else {
    // 'all' - union of all SNPs
    targetSnps = Array.from(snpCounts.keys());
  }

  if (targetSnps.length === 0) return null;

  // Build matrix
  const matrix = Array.from(pgsSnpMaps.entries()).map(([pgsId, snpMap]) => {
    const row = { label: pgsId };
    for (const snp of targetSnps) {
      row[snp] = snpMap.has(snp) ? snpMap.get(snp) : missingValue;
    }
    return row;
  });

  // console.log(`buildPgsVsSnpsMatrix (${mode}): ${matrix.length} PGS entries × ${targetSnps.length} SNPs for user ${targetUserId}`);
  return matrix;
}

// /** PGS x PGS matrix builder for clustering PGS entries by their SNP effect weights 
//  * Extract SNP data from a PGS model.
//  * Returns a Map of snpId -> effect_weight
//  */
// function extractPgsSnpWeights(pgs) {
//   if (!pgs?.dt || !pgs?.cols) return new Map();
  
//   const indChr = pgs.cols.indexOf('hm_chr');
//   const indPos = pgs.cols.indexOf('hm_pos');
//   const indRsid = pgs.cols.indexOf('rsID');
//   const indWeight = pgs.cols.indexOf('effect_weight');
  
//   const snpData = new Map();
  
//   for (const variant of pgs.dt) {
//     let snpId;
//     if (indRsid >= 0 && variant[indRsid]) {
//       snpId = variant[indRsid];
//     } else if (indChr >= 0 && indPos >= 0) {
//       snpId = `${variant[indChr]}:${variant[indPos]}`;
//     }
//     if (!snpId) continue;
    
//     const weight = indWeight >= 0 ? parseFloat(variant[indWeight]) : 0;
//     if (Number.isFinite(weight)) {
//       snpData.set(snpId, weight);
//     }
//   }
  
//   return snpData;
// }
/** PGS x PGS matrix builder for clustering PGS entries by their SNP effect weights
 * Extract SNP effect weights from one PGS model.
 * Returns Map<snpId, effect_weight>
 */
function extractPgsSnpWeights(pgs) {
  if (!pgs || !Array.isArray(pgs.dt) || !Array.isArray(pgs.cols)) {
    return new Map();
  }

  const indChr = pgs.cols.indexOf("hm_chr");
  const indPos = pgs.cols.indexOf("hm_pos");
  const indRsid = pgs.cols.indexOf("rsID");
  const indWeight = pgs.cols.indexOf("effect_weight");

  const snpData = new Map();

  for (const variant of pgs.dt) {
    if (!Array.isArray(variant)) continue;

    let snpId = null;

    if (indRsid >= 0) {
      const rawRsid = variant[indRsid];
      if (rawRsid != null) {
        const rsid = String(rawRsid).trim();
        if (rsid && rsid !== "." && rsid.toUpperCase() !== "NA") {
          snpId = rsid;
        }
      }
    }

    if (!snpId && indChr >= 0 && indPos >= 0) {
      const chr = variant[indChr];
      const pos = variant[indPos];

      if (chr != null && pos != null && String(chr).trim() && String(pos).trim()) {
        snpId = `${String(chr).trim()}:${String(pos).trim()}`;
      }
    }

    if (!snpId) continue;

    if (indWeight < 0) continue;

    const weight = parseFloat(variant[indWeight]);
    if (!Number.isFinite(weight)) continue;

    snpData.set(snpId, weight);
  }

  return snpData;
}


/**
 * Count how many PGS entries contain each SNP
 */
function countSnpsAcrossPgs(rawResults) {
  const counts = new Map();
  const seenPgs = new Set();
  
  for (const r of rawResults) {
    if (!r.pgsId || !r.pgs?.dt || seenPgs.has(r.pgsId)) continue;
    seenPgs.add(r.pgsId);
    
    const snpWeights = extractPgsSnpWeights(r.pgs);
    for (const snp of snpWeights.keys()) {
      counts.set(snp, (counts.get(snp) || 0) + 1);
    }
  }
  
  return counts;
}

/**
 * Get all unique SNPs across all PGS entries (union)
 */
function getAllSnpsFromPgs(rawResults) {
  const counts = countSnpsAcrossPgs(rawResults);
  return Array.from(counts.keys());
}

/**
 * Get SNPs that appear in at least 2 PGS entries
 */
function getOverlappingSnpsFromPgs(rawResults) {
  const counts = countSnpsAcrossPgs(rawResults);
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([snp]) => snp);
}

/**
 * Get SNPs that appear in ALL PGS entries
 */
function getSharedSnpsFromPgs(rawResults) {
  const counts = countSnpsAcrossPgs(rawResults);
  const pgsCount = getUniquePgsIds(rawResults).length;
  return [...counts.entries()]
    .filter(([, count]) => count === pgsCount)
    .map(([snp]) => snp);
}

/**
 * Z-score normalize rows of a matrix
 */
function zscoreRows(matrix) {
  return matrix.map(row => {
    if (!row.length) return row;
    const mean = row.reduce((a, b) => a + b, 0) / row.length;
    const std = Math.sqrt(row.reduce((a, b) => a + (b - mean) ** 2, 0) / row.length);
    return row.map(v => (v - mean) / (std || 1));
  });
}

/**
 * Build PGS × SNP effect weight matrix.
 * Rows = PGS entries, Columns = SNPs, Values = effect_weight (z-scored)
 * Returns object with { data, displayData, snpCount, pgsCount } for hclust_plot
 * - data: z-scored values with 0 for missing (for clustering)
 * - displayData: raw values with -1 for missing (for display, shows as black)
 */
function buildPgsEffectWeightMatrix(rawResults, snpList) {
  if (!snpList || snpList.length === 0) return null;
  
  // Get unique PGS entries
  const pgsMap = new Map();
  for (const r of rawResults) {
    if (r.pgsId && r.pgs?.dt && !pgsMap.has(r.pgsId)) {
      pgsMap.set(r.pgsId, r.pgs);
    }
  }
  
  const pgsIds = Array.from(pgsMap.keys());
  if (pgsIds.length < 2) return null;
  
  // Build raw matrix (rows = PGS, cols = SNPs)
  // Track which cells are missing (SNP not in that PGS)
  const rawMatrix = [];
  const missingMask = []; // true if missing
  for (const pgsId of pgsIds) {
    const pgs = pgsMap.get(pgsId);
    const snpWeights = extractPgsSnpWeights(pgs);
    const row = [];
    const maskRow = [];
    for (const snp of snpList) {
      if (snpWeights.has(snp)) {
        row.push(snpWeights.get(snp));
        maskRow.push(false);
      } else {
        row.push(0); // Use 0 for clustering
        maskRow.push(true);
      }
    }
    rawMatrix.push(row);
    missingMask.push(maskRow);
  }
  
  // Remove constant columns (all same value)
  const keepCols = [];
  for (let j = 0; j < snpList.length; j++) {
    const col = rawMatrix.map(row => row[j]);
    const mean = col.reduce((a, b) => a + b, 0) / col.length;
    const variance = col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length;
    if (variance > 1e-10) keepCols.push(j);
  }
  
  const filteredSnps = keepCols.map(j => snpList[j]);
  const filteredMatrix = rawMatrix.map(row => keepCols.map(j => row[j]));
  const filteredMask = missingMask.map(row => keepCols.map(j => row[j]));
  
  if (filteredSnps.length === 0) return null;
  
  // Z-score normalize rows
  const zMatrix = zscoreRows(filteredMatrix);
  
  // Convert to hclust_plot format: [{label, snp1: val, snp2: val, ...}, ...]
  const data = pgsIds.map((pgsId, i) => {
    const row = { label: pgsId };
    filteredSnps.forEach((snp, j) => {
      row[snp] = zMatrix[i][j];
    });
    return row;
  });
  
  // Build display data with -1 for missing (shows as black)
  const displayData = pgsIds.map((pgsId, i) => {
    const row = { label: pgsId };
    filteredSnps.forEach((snp, j) => {
      row[snp] = filteredMask[i][j] ? -1 : filteredMatrix[i][j];
    });
    return row;
  });
  
  // console.log(`buildPgsEffectWeightMatrix: ${pgsIds.length} PGS × ${filteredSnps.length} SNPs (from ${snpList.length} input)`);
  
  return { data, displayData, snpCount: filteredSnps.length, pgsCount: pgsIds.length };
}


async function renderCluster() {
  const clusterContainer = document.getElementById(clusterContainerId);
  if (!clusterContainer) return;

  // Check cache validity
  const currentHash = hashPrsResults(window.prsResults);
  const cacheValid = isCacheValid(currentHash);
  
  // Show loading state immediately if we need to compute (not cached)
  const needsCompute = !cacheValid || !clusterCache.pivoted;
  if (needsCompute) {
    clusterContainer.innerHTML = `
      <div class="d-flex flex-column align-items-center justify-content-center py-5">
        <div class="spinner-border text-primary mb-3" role="status" style="width: 3rem; height: 3rem;">
          <span class="visually-hidden">Loading...</span>
        </div>
        <p class="text-muted loading-message">Loading cluster analysis...</p>
      </div>
    `;
    // Allow the loading UI to render before heavy computation
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 10)));
  }
  
  // Use cached or compute fresh data
  let pivoted, pgsIds, userIds;
  if (cacheValid && clusterCache.pivoted) {
    pivoted = clusterCache.pivoted;
    pgsIds = clusterCache.pgsIds;
    userIds = clusterCache.userIds;
    // console.log("Using cached base data for cluster tab");
  } else {
    // console.log("Computing fresh base data for cluster tab");
    pivoted = pivotPrsResults(window.prsResults);
    pgsIds = getUniquePgsIds(window.prsResults);
    userIds = getUniqueUserIds(window.prsResults);
    // Update cache
    clusterCache.prsResultsHash = currentHash;
    clusterCache.pivoted = pivoted;
    clusterCache.pgsIds = pgsIds;
    clusterCache.userIds = userIds;
    // Invalidate dependent caches when base data changes
    clusterCache.alleleMatrices = null;
    clusterCache.pgsVsSnpsMatrices = null;
    clusterCache.effectMatrices = null;
    clusterCache.snpLists = null;
  }
  
  //console.log("Pivoted PRS results for clustering:", pivoted);
  // Show message if no PRS results available
  if (pivoted === null) {
    clusterContainer.innerHTML = `<div class="alert alert-info">
        <strong>No PRS results available.</strong><br>
        Please go to the <strong>Calculate PRS</strong> tab first and run a PRS calculation. <a href="#" onclick="document.querySelector('.tablinks[onclick*=PRS]').click(); return false;">Go to Calculate PRS →</a>
    </div>`;
    return;
  }

  // Get current clustering options (preserve state across re-renders)
  const clusterRows = window.clusterOptions?.clusterRows ?? true;
  const clusterCols = window.clusterOptions?.clusterCols ?? true;
  const selectedPgsId = window.clusterOptions?.selectedPgsId ?? pgsIds[0] ?? '';
  const clusterAlleleRows = window.clusterOptions?.clusterAlleleRows ?? true;
  const clusterAlleleCols = window.clusterOptions?.clusterAlleleCols ?? true;
  
  // Clustering algorithm options
  const clusterMethod = window.clusterOptions?.clusterMethod ?? 'complete';
  const clusterDistance = window.clusterOptions?.clusterDistance ?? 'euclidean';
  const alleleClusterMethod = window.clusterOptions?.alleleClusterMethod ?? 'complete';
  const alleleClusterDistance = window.clusterOptions?.alleleClusterDistance ?? 'euclidean';
  const alleleValueMode = window.clusterOptions?.alleleValueMode ?? 'allele';
  
  // PGS vs SNPs clustering options (single user view)
  const selectedUserId = window.clusterOptions?.selectedUserId ?? (userIds[0]?.id ?? '');
  const pgsVsSnpsClusterRows = window.clusterOptions?.pgsVsSnpsClusterRows ?? true;
  const pgsVsSnpsClusterCols = window.clusterOptions?.pgsVsSnpsClusterCols ?? false;

  // PGS × SNP Effect Weight clustering options
  const effectClusterRows = window.clusterOptions?.effectClusterRows ?? true;
  const effectClusterCols = window.clusterOptions?.effectClusterCols ?? false;

  // Helper to update loading message
  const updateLoading = async (message) => {
    const loadingEl = clusterContainer.querySelector('.loading-message');
    if (loadingEl) loadingEl.textContent = message;
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  };

  // Build allele matrices for selected PGS - three views (with caching)
  let allMatrix, allMatrixDisplay, overlapMatrix, overlapMatrixDisplay, sharedMatrix, sharedMatrixDisplay;
  
  const allelesCacheKey = `${currentHash}-${selectedPgsId}-${alleleValueMode}`;
  if (clusterCache.alleleMatrices?.cacheKey === allelesCacheKey) {
    // console.log("Using cached allele matrices");
    ({ allMatrix, allMatrixDisplay, overlapMatrix, overlapMatrixDisplay, sharedMatrix, sharedMatrixDisplay } = clusterCache.alleleMatrices);
  } else if (selectedPgsId) {
    await updateLoading("Building allele matrices...");
    // console.log("Computing fresh allele matrices for", selectedPgsId);
    allMatrix = buildAlleleMatrix(window.prsResults, selectedPgsId, { mode: 'all', missingValue: 0, valueMode: alleleValueMode });
    allMatrixDisplay = buildAlleleMatrix(window.prsResults, selectedPgsId, { mode: 'all', missingValue: -1, valueMode: alleleValueMode });
    overlapMatrix = buildAlleleMatrix(window.prsResults, selectedPgsId, { mode: 'overlapping', missingValue: 0, valueMode: alleleValueMode });
    overlapMatrixDisplay = buildAlleleMatrix(window.prsResults, selectedPgsId, { mode: 'overlapping', missingValue: -1, valueMode: alleleValueMode });
    sharedMatrix = buildAlleleMatrix(window.prsResults, selectedPgsId, { mode: 'shared', missingValue: 0, valueMode: alleleValueMode });
    sharedMatrixDisplay = buildAlleleMatrix(window.prsResults, selectedPgsId, { mode: 'shared', missingValue: -1, valueMode: alleleValueMode });
    clusterCache.alleleMatrices = { cacheKey: allelesCacheKey, allMatrix, allMatrixDisplay, overlapMatrix, overlapMatrixDisplay, sharedMatrix, sharedMatrixDisplay };
  }

  const totalVariants = getTotalVariants(window.prsResults, selectedPgsId);
  const allCount = allMatrix ? Object.keys(allMatrix[0]).length - 1 : 0;
  const overlapCount = overlapMatrix ? Object.keys(overlapMatrix[0]).length - 1 : 0;
  const sharedCount = sharedMatrix ? Object.keys(sharedMatrix[0]).length - 1 : 0;
  const sharedPct = totalVariants > 0 ? ((sharedCount / totalVariants) * 100).toFixed(1) : '0.0';
  const overlapPct = totalVariants > 0 ? ((overlapCount / totalVariants) * 100).toFixed(1) : '0.0';
  const betaContributionByUser = getBetaContributionByUser(window.prsResults, selectedPgsId);

  // Build PGS vs SNPs matrices for selected user - three views (with caching)
  let pgsVsSnpsAllMatrix, pgsVsSnpsAllMatrixDisplay, pgsVsSnpsOverlapMatrix, pgsVsSnpsOverlapMatrixDisplay, pgsVsSnpsSharedMatrix, pgsVsSnpsSharedMatrixDisplay;
  
  const pgsVsSnpsCacheKey = `${currentHash}-${selectedUserId}`;
  if (clusterCache.pgsVsSnpsMatrices?.cacheKey === pgsVsSnpsCacheKey) {
    // console.log("Using cached PGS vs SNPs matrices");
    ({ pgsVsSnpsAllMatrix, pgsVsSnpsAllMatrixDisplay, pgsVsSnpsOverlapMatrix, pgsVsSnpsOverlapMatrixDisplay, pgsVsSnpsSharedMatrix, pgsVsSnpsSharedMatrixDisplay } = clusterCache.pgsVsSnpsMatrices);
  } else if (selectedUserId) {
    await updateLoading("Building PGS vs SNPs matrices...");
    // console.log("Computing fresh PGS vs SNPs matrices for", selectedUserId);
    pgsVsSnpsAllMatrix = buildPgsVsSnpsMatrix(window.prsResults, selectedUserId, { missingValue: 0, mode: 'all' });
    pgsVsSnpsAllMatrixDisplay = buildPgsVsSnpsMatrix(window.prsResults, selectedUserId, { missingValue: -1, mode: 'all' });
    pgsVsSnpsOverlapMatrix = buildPgsVsSnpsMatrix(window.prsResults, selectedUserId, { missingValue: 0, mode: 'overlapping' });
    pgsVsSnpsOverlapMatrixDisplay = buildPgsVsSnpsMatrix(window.prsResults, selectedUserId, { missingValue: -1, mode: 'overlapping' });
    pgsVsSnpsSharedMatrix = buildPgsVsSnpsMatrix(window.prsResults, selectedUserId, { missingValue: 0, mode: 'shared' });
    pgsVsSnpsSharedMatrixDisplay = buildPgsVsSnpsMatrix(window.prsResults, selectedUserId, { missingValue: -1, mode: 'shared' });
    clusterCache.pgsVsSnpsMatrices = { cacheKey: pgsVsSnpsCacheKey, pgsVsSnpsAllMatrix, pgsVsSnpsAllMatrixDisplay, pgsVsSnpsOverlapMatrix, pgsVsSnpsOverlapMatrixDisplay, pgsVsSnpsSharedMatrix, pgsVsSnpsSharedMatrixDisplay };
  }
  
  const pgsVsSnpsAllCount = pgsVsSnpsAllMatrix ? Object.keys(pgsVsSnpsAllMatrix[0]).length - 1 : 0;
  const pgsVsSnpsOverlapCount = pgsVsSnpsOverlapMatrix ? Object.keys(pgsVsSnpsOverlapMatrix[0]).length - 1 : 0;
  const pgsVsSnpsSharedCount = pgsVsSnpsSharedMatrix ? Object.keys(pgsVsSnpsSharedMatrix[0]).length - 1 : 0;
  const pgsVsSnpsPgsCount = pgsVsSnpsAllMatrix ? pgsVsSnpsAllMatrix.length : 0;
  const selectedUserName = userIds.find(u => u.id === selectedUserId)?.name ?? selectedUserId;

  // Build PGS × SNP effect weight matrices (three views) - with caching
  let allSnpsList, overlapSnpsList, sharedSnpsList, pgsEffectAll, pgsEffectOverlap, pgsEffectShared;
  
  const effectCacheKey = currentHash;
  if (clusterCache.effectMatrices?.cacheKey === effectCacheKey) {
    // console.log("Using cached effect weight matrices");
    ({ allSnpsList, overlapSnpsList, sharedSnpsList } = clusterCache.snpLists);
    ({ pgsEffectAll, pgsEffectOverlap, pgsEffectShared } = clusterCache.effectMatrices);
  } else {
    await updateLoading("Building effect weight matrices...");
    // console.log("Computing fresh effect weight matrices");
    allSnpsList = getAllSnpsFromPgs(window.prsResults);
    overlapSnpsList = getOverlappingSnpsFromPgs(window.prsResults);
    sharedSnpsList = getSharedSnpsFromPgs(window.prsResults);
    pgsEffectAll = buildPgsEffectWeightMatrix(window.prsResults, allSnpsList);
    pgsEffectOverlap = buildPgsEffectWeightMatrix(window.prsResults, overlapSnpsList);
    pgsEffectShared = buildPgsEffectWeightMatrix(window.prsResults, sharedSnpsList);
    clusterCache.snpLists = { allSnpsList, overlapSnpsList, sharedSnpsList };
    clusterCache.effectMatrices = { cacheKey: effectCacheKey, pgsEffectAll, pgsEffectOverlap, pgsEffectShared };
  }
  
  const pgsEffectPgsCount = pgsEffectAll?.pgsCount ?? 0;

  // Build genotype allele matrix (section E)
  let genotypeMatrix = null;
  let genotypeMatrixResult = null;

  const genotypeCacheKey = currentHash;
  if (clusterCache.genotypeDistData?.cacheKey === genotypeCacheKey) {
    genotypeMatrixResult = clusterCache.genotypeDistData.result;
    genotypeMatrix = clusterCache.genotypeDistData.plotData;
  } else {
    await updateLoading("Building genotype allele matrix...");
    genotypeMatrixResult = buildUserSnpGenotypeMatrix(window.prsResults, { mode: 'shared', missingValue: -1 });
    if (genotypeMatrixResult) {
      genotypeMatrix = genotypeMatrixResult.matrix;
      clusterCache.genotypeDistData = { cacheKey: genotypeCacheKey, result: genotypeMatrixResult, plotData: genotypeMatrix };
    }
  }

  const genotypeClusterRows = window.clusterOptions?.genotypeClusterRows ?? true;
  const genotypeClusterCols = window.clusterOptions?.genotypeClusterCols ?? false;
  const genotypeClusterMethod = window.clusterOptions?.genotypeClusterMethod ?? 'complete';
  const genotypeClusterDistance = window.clusterOptions?.genotypeClusterDistance ?? 'euclidean';
  const activeClusterSection = window.clusterOptions?.activeClusterSection ?? 'A';

  // Update loading message before rendering
  await updateLoading("Rendering clusters...");

  clusterContainer.innerHTML = `
    <div class="mb-3">
      <strong>Display Section:</strong>
      <div class="btn-group ms-2 flex-wrap" role="group" aria-label="Cluster sections">
        <button id="displayA" class="btn btn-sm ${activeClusterSection === 'A' ? 'btn-primary' : 'btn-outline-primary'}">A. PRS Clustering</button>
        <button id="displayB" class="btn btn-sm ${activeClusterSection === 'B' ? 'btn-primary' : 'btn-outline-primary'}">B. Users × One PGS</button>
        <button id="displayC" class="btn btn-sm ${activeClusterSection === 'C' ? 'btn-primary' : 'btn-outline-primary'}">C. PGS × One User</button>
        <button id="displayD" class="btn btn-sm ${activeClusterSection === 'D' ? 'btn-primary' : 'btn-outline-primary'}">D. PGS × PGS Weights</button>
        <button id="displayE" class="btn btn-sm ${activeClusterSection === 'E' ? 'btn-primary' : 'btn-outline-primary'}">E. Genotype-level Clustering</button>
        <button id="displayF" class="btn btn-sm ${activeClusterSection === 'F' ? 'btn-primary' : 'btn-outline-primary'}">F. Genome-wide Genotypes</button>
      </div>
    </div>

    <div id="clusterSectionA" style="display:${activeClusterSection === 'A' ? 'block' : 'none'};">
    <h5>A. PRS Clustering (${pivoted.length} Users × ${Object.keys(pivoted[0]).length - 1} PGS Entries)</h5>
    <p class="text-muted small mb-2">
      Hierarchical clustering of PRS results (${pivoted.length} users × ${Object.keys(pivoted[0]).length - 1} PGS entries).
    </p>
    <div class="mb-3">
      <button id="downloadPrsMatrixBtn" class="btn btn-outline-secondary btn-sm">
        ⬇ Download PRS Matrix JSON
      </button>
      <button id="downloadPrsCsvBtn" class="btn btn-outline-secondary btn-sm ms-2">
        ⬇ Build matrix &amp; download CSV
      </button>
      <span class="text-muted small ms-2">ClustJS-compatible format: array of row objects with a <code>label</code> field and one field per PGS ID.</span>
    </div>
    <div class="mb-2">
      <strong>Cluster by:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="clusterRowsBtn" class="btn btn-sm ${clusterRows ? 'btn-primary' : 'btn-outline-primary'}">Rows (Users)</button>
        <button id="clusterColsBtn" class="btn btn-sm ${clusterCols ? 'btn-primary' : 'btn-outline-primary'}">Columns (PGS)</button>
        <button id="clusterBothBtn" class="btn btn-sm ${clusterRows && clusterCols ? 'btn-success' : 'btn-outline-success'}">Both</button>
      </div>
    </div>
    <div class="mb-2">
      <strong>Linkage:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="clusterMethodComplete" class="btn btn-sm ${clusterMethod === 'complete' ? 'btn-secondary' : 'btn-outline-secondary'}">Complete</button>
        <button id="clusterMethodSingle" class="btn btn-sm ${clusterMethod === 'single' ? 'btn-secondary' : 'btn-outline-secondary'}">Single</button>
        <button id="clusterMethodAverage" class="btn btn-sm ${clusterMethod === 'average' ? 'btn-secondary' : 'btn-outline-secondary'}">Average</button>
        <button id="clusterMethodWard" class="btn btn-sm ${clusterMethod === 'ward' ? 'btn-secondary' : 'btn-outline-secondary'}">Ward</button>
      </div>
    </div>
    <div class="mb-3">
      <strong>Distance:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="clusterDistEuclidean" class="btn btn-sm ${clusterDistance === 'euclidean' ? 'btn-info' : 'btn-outline-info'}">Euclidean</button>
        <button id="clusterDistManhattan" class="btn btn-sm ${clusterDistance === 'manhattan' ? 'btn-info' : 'btn-outline-info'}">Manhattan</button>
        <button id="clusterDistCosine" class="btn btn-sm ${clusterDistance === 'cosine' ? 'btn-info' : 'btn-outline-info'}">Cosine</button>
      </div>
    </div>
    <div id="clusterPlotMount"></div>
    </div>

    <div id="clusterSectionB" style="display:${activeClusterSection === 'B' ? 'block' : 'none'};">
    <h5>B. Users x one PGS, ${alleleValueMode === 'risk_x_allele' ? 'risk × allele' : 'allele counts'} (${pivoted.length} Users × ${totalVariants} Variants for ${selectedPgsId})</h5>
    <p class="text-muted small mb-2">
      ${alleleValueMode === 'risk_x_allele'
        ? 'Cluster users by risk × allele values for variants in a single PGS model. Non-matched variants shown in black.'
        : 'Cluster users by allele counts (0, 1, 2) for variants in a single PGS model. Non-matched variants shown in black.'}
    </p>
    <div class="mb-3">
      <label for="pgsSelectDropdown" class="form-label"><strong>Select PGS Model:</strong></label>
      <select id="pgsSelectDropdown" class="form-select" style="max-width: 400px;">
        ${pgsIds.map(id => {
          const year = getPublicationYear(window.prsResults, id);
          const yearStr = year ? ` (${year})` : '';
          return `<option value="${id}" ${id === selectedPgsId ? 'selected' : ''}>${id}${yearStr} — ${getTotalVariants(window.prsResults, id)} variants</option>`;
        }).join('')}
      </select>
    </div>

    <div class="mb-2">
      <strong>Cluster by:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="clusterAlleleRowsBtn" class="btn btn-sm ${clusterAlleleRows ? 'btn-primary' : 'btn-outline-primary'}">Rows (Users)</button>
        <button id="clusterAlleleColsBtn" class="btn btn-sm ${clusterAlleleCols ? 'btn-primary' : 'btn-outline-primary'}">Columns (Variants)</button>
        <button id="clusterAlleleBothBtn" class="btn btn-sm ${clusterAlleleRows && clusterAlleleCols ? 'btn-success' : 'btn-outline-success'}">Both</button>
      </div>
    </div>
    <div class="mb-2">
      <strong>Linkage:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="alleleMethodComplete" class="btn btn-sm ${alleleClusterMethod === 'complete' ? 'btn-secondary' : 'btn-outline-secondary'}">Complete</button>
        <button id="alleleMethodSingle" class="btn btn-sm ${alleleClusterMethod === 'single' ? 'btn-secondary' : 'btn-outline-secondary'}">Single</button>
        <button id="alleleMethodAverage" class="btn btn-sm ${alleleClusterMethod === 'average' ? 'btn-secondary' : 'btn-outline-secondary'}">Average</button>
        <button id="alleleMethodWard" class="btn btn-sm ${alleleClusterMethod === 'ward' ? 'btn-secondary' : 'btn-outline-secondary'}">Ward</button>
      </div>
    </div>
    <div class="mb-3">
      <strong>Distance:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="alleleDistEuclidean" class="btn btn-sm ${alleleClusterDistance === 'euclidean' ? 'btn-info' : 'btn-outline-info'}">Euclidean</button>
        <button id="alleleDistManhattan" class="btn btn-sm ${alleleClusterDistance === 'manhattan' ? 'btn-info' : 'btn-outline-info'}">Manhattan</button>
        <button id="alleleDistCosine" class="btn btn-sm ${alleleClusterDistance === 'cosine' ? 'btn-info' : 'btn-outline-info'}">Cosine</button>
      </div>
    </div>
    <div class="mb-3">
      <strong>Values:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="alleleValueAlleleBtn" class="btn btn-sm ${alleleValueMode === 'allele' ? 'btn-dark' : 'btn-outline-dark'}">Allele Count</button>
        <button id="alleleValueRiskXAlleleBtn" class="btn btn-sm ${alleleValueMode === 'risk_x_allele' ? 'btn-dark' : 'btn-outline-dark'}">Risk × Allele</button>
      </div>
    </div>
    <div class="card mb-4">
      <div class="card-header"><strong>Beta Contribution by User</strong> <span class="text-muted small">— matched vs unmatched variants</span></div>
      <div class="card-body">
        ${betaContributionByUser.length > 0 ? `
          <div class="d-flex flex-row flex-wrap gap-3 align-items-start">
            ${betaContributionByUser.map((u, idx) => `
              <div class="border rounded p-2" style="min-width: 155px;">
                <div class="small fw-semibold mb-1">${u.userLabel}</div>
                <div id="betaContributionPieUser_${idx}" style="width: 125px; height: 125px;"></div>
                <div class="text-muted" style="font-size: 0.78rem;">Σβ m=${Number(u.matchedBeta).toFixed(3)}, u=${Number(u.unmatchedBeta).toFixed(3)}</div>
              </div>
            `).join('')}
          </div>
        ` : `<div class="alert alert-warning mb-0">No beta contribution data available for this PGS.</div>`}
      </div>
    </div>

    <!-- 1. All Variants -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>1. All Variants</strong> <span class="text-muted small">— Broad view, includes non-matches (black = missing)</span></span>${allMatrix ? '<button id="downloadBAllBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${allMatrix ? `
          <p class="text-muted small mb-2">${allMatrix.length} users × ${allCount} variants (of ${totalVariants} total in PGS)</p>
          <div id="allVariantsPlot"></div>
        ` : `<div class="alert alert-warning mb-0">Not enough data for all-variants view.</div>`}
      </div>
    </div>

    <!-- 2. Overlapping Matches -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>2. Overlapping Matches</strong> <span class="text-muted small">— SNPs matched in ≥1 user (cleaner view)</span></span>${overlapMatrix ? '<button id="downloadBOverlapBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${overlapMatrix ? `
          <p class="text-muted small mb-2">${overlapMatrix.length} users × ${overlapCount} variants (${overlapPct}% of total)</p>
          <div id="overlapPlot"></div>
        ` : `<div class="alert alert-warning mb-0">Not enough overlapping matches.</div>`}
      </div>
    </div>

    <!-- 3. Shared Matched SNPs -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>3. Shared Matched SNPs</strong> <span class="text-muted small">— SNPs matched in ALL users (best for direct comparison)</span></span>${sharedMatrix ? '<button id="downloadBSharedBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${sharedMatrix ? `
          <p class="text-muted small mb-2">${sharedMatrix.length} users × ${sharedCount} variants (${sharedPct}% of total)</p>
          <div id="sharedPlot"></div>
        ` : `<div class="alert alert-warning mb-0">No variants shared across all users.</div>`}
      </div>
    </div>

    </div>

    <div id="clusterSectionC" style="display:${activeClusterSection === 'C' ? 'block' : 'none'};">
    <h5>C. PGS vs One user, allele counts(${pgsVsSnpsPgsCount} PGS Entries for ${selectedUserName})</h5>
    <p class="text-muted small mb-2">
      Cluster PGS entries by their matched SNP allele patterns for a single user. Rows = PGS entries, Columns = SNPs.
    </p>
    <div class="mb-3">
      <label for="userSelectDropdown" class="form-label"><strong>Select User:</strong></label>
      <select id="userSelectDropdown" class="form-select" style="max-width: 400px;">
        ${userIds.map(u => {
          const displayName = u.name !== u.id ? `${u.id} (${u.name})` : u.id;
          return `<option value="${u.id}" ${u.id === selectedUserId ? 'selected' : ''}>${displayName}</option>`;
        }).join('')}
      </select>
    </div>

    <div class="mb-3">
      <strong>Cluster by:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="pgsVsSnpsRowsBtn" class="btn btn-sm ${pgsVsSnpsClusterRows ? 'btn-primary' : 'btn-outline-primary'}">Rows (PGS)</button>
        <button id="pgsVsSnpsColsBtn" class="btn btn-sm ${pgsVsSnpsClusterCols ? 'btn-primary' : 'btn-outline-primary'}">Columns (SNPs)</button>
        <button id="pgsVsSnpsBothBtn" class="btn btn-sm ${pgsVsSnpsClusterRows && pgsVsSnpsClusterCols ? 'btn-success' : 'btn-outline-success'}">Both</button>
      </div>
      <span class="text-muted small ms-2">(Note: Column clustering may be slow with many SNPs)</span>
    </div>

    <div class="mb-3">
      <p class="small">
        <strong>All SNPs:</strong> ${pgsVsSnpsAllCount} | 
        <strong>Overlapping (≥2 PGS):</strong> ${pgsVsSnpsOverlapCount} | 
        <strong>Shared (all PGS):</strong> ${pgsVsSnpsSharedCount}
      </p>
    </div>

    <!-- 1. All SNPs -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>1. All SNPs</strong> <span class="text-muted small">— Union of all matched SNPs across PGS entries</span></span>${pgsVsSnpsAllMatrix ? '<button id="downloadCAllBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${pgsVsSnpsAllMatrix ? `
          <p class="text-muted small mb-2">${pgsVsSnpsPgsCount} PGS entries × ${pgsVsSnpsAllCount} SNPs</p>
          <div id="pgsVsSnpsAllPlot"></div>
        ` : `<div class="alert alert-warning mb-0">Not enough PGS entries (need ≥2) or no matched SNPs for this user.</div>`}
      </div>
    </div>

    <!-- 2. Overlapping SNPs -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>2. Overlapping SNPs</strong> <span class="text-muted small">— SNPs matched in ≥2 PGS entries</span></span>${pgsVsSnpsOverlapMatrix ? '<button id="downloadCOverlapBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${pgsVsSnpsOverlapMatrix ? `
          <p class="text-muted small mb-2">${pgsVsSnpsPgsCount} PGS entries × ${pgsVsSnpsOverlapCount} SNPs</p>
          <div id="pgsVsSnpsOverlapPlot"></div>
        ` : `<div class="alert alert-warning mb-0">No overlapping SNPs found across PGS entries for this user.</div>`}
      </div>
    </div>

    <!-- 3. Shared SNPs -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>3. Shared SNPs (All PGS)</strong> <span class="text-muted small">— SNPs matched in ALL PGS entries</span></span>${pgsVsSnpsSharedMatrix ? '<button id="downloadCSharedBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${pgsVsSnpsSharedMatrix ? `
          <p class="text-muted small mb-2">${pgsVsSnpsPgsCount} PGS entries × ${pgsVsSnpsSharedCount} SNPs</p>
          <div id="pgsVsSnpsSharedPlot"></div>
        ` : `<div class="alert alert-warning mb-0">No SNPs shared across all PGS entries for this user.</div>`}
      </div>
    </div>

    </div>

    <div id="clusterSectionD" style="display:${activeClusterSection === 'D' ? 'block' : 'none'};">
    <h5>D. PGS × PGS effect wirghts (${pgsEffectPgsCount} PGS Entries)</h5>
    <p class="text-muted small mb-2">
      Cluster PGS entries by their SNP effect weights (z-scored). Rows = PGS, Columns = SNPs, Values = effect_weight.
    </p>

    <div class="mb-3">
      <strong>Cluster by:</strong>
      <div class="btn-group ms-2" role="group">
        <button id="effectClusterRowsBtn" class="btn btn-sm ${effectClusterRows ? 'btn-primary' : 'btn-outline-primary'}">Rows (PGS)</button>
        <button id="effectClusterColsBtn" class="btn btn-sm ${effectClusterCols ? 'btn-primary' : 'btn-outline-primary'}">Columns (SNPs)</button>
        <button id="effectClusterBothBtn" class="btn btn-sm ${effectClusterRows && effectClusterCols ? 'btn-success' : 'btn-outline-success'}">Both</button>
      </div>
      <span class="text-muted small ms-2">(Column clustering may be slow with many SNPs)</span>
    </div>

    <div class="mb-3">
      <p class="small">
        <strong>All SNPs:</strong> ${allSnpsList.length} | 
        <strong>Overlapping (≥2 PGS):</strong> ${overlapSnpsList.length} | 
        <strong>Shared (all PGS):</strong> ${sharedSnpsList.length}
      </p>
    </div>

    <!-- 1. All SNPs Effect Weight -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>1. All SNPs</strong> <span class="text-muted small">— Union of all SNPs across PGS entries</span></span>${pgsEffectAll ? '<button id="downloadDAllBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${pgsEffectAll ? `
          <p class="text-muted small mb-2">${pgsEffectAll.pgsCount} PGS × ${pgsEffectAll.snpCount} SNPs (after removing constant columns)</p>
          <div id="pgsEffectAllPlot"></div>
        ` : `<div class="alert alert-warning mb-0">Not enough PGS entries or no variable SNPs.</div>`}
      </div>
    </div>

    <!-- 2. Overlapping SNPs Effect Weight -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>2. Overlapping SNPs</strong> <span class="text-muted small">— SNPs found in ≥2 PGS entries</span></span>${pgsEffectOverlap ? '<button id="downloadDOverlapBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${pgsEffectOverlap ? `
          <p class="text-muted small mb-2">${pgsEffectOverlap.pgsCount} PGS × ${pgsEffectOverlap.snpCount} SNPs</p>
          <div id="pgsEffectOverlapPlot"></div>
        ` : `<div class="alert alert-warning mb-0">No overlapping SNPs found across PGS entries.</div>`}
      </div>
    </div>

    <!-- 3. Shared SNPs Effect Weight -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center"><span><strong>3. Shared SNPs (All PGS)</strong> <span class="text-muted small">— SNPs found in every PGS model</span></span>${pgsEffectShared ? '<button id="downloadDSharedBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>' : ''}</div>
      <div class="card-body">
        ${pgsEffectShared ? `
          <p class="text-muted small mb-2">${pgsEffectShared.pgsCount} PGS × ${pgsEffectShared.snpCount} SNPs</p>
          <div id="pgsEffectSharedPlot"></div>
        ` : `<div class="alert alert-warning mb-0">No SNPs shared across all PGS entries.</div>`}
      </div>
    </div>

    </div>

    <div id="clusterSectionE" style="display:${activeClusterSection === 'E' ? 'block' : 'none'};">
    <h5>E. Genotype-level Clustering ${genotypeMatrixResult ? `(${genotypeMatrixResult.userIds.length} Users × ${genotypeMatrixResult.snpCount} Shared SNPs, all PGS combined)` : '(No data)'}</h5>
    <div class="text-muted small mb-3">
      <div><b>Summary:</b> ${genotypeMatrixResult ? `${genotypeMatrixResult.userIds.length} users clustered by ${genotypeMatrixResult.snpCount} SNPs shared across all users and all loaded PGS models.` : 'No summary available.'}</div>
      <div>
        ${genotypeMatrixResult
          ? 'Genotype similarity was quantified using allele-sharing distance, where genotypes sharing two, one, or zero alleles were assigned distances of 0, 1, and 2, respectively. Each cell shows the encoded raw genotype (AA=0, AC=1, AG=2, AT=3, CC=4, CG=5, CT=6, GG=7, GT=8, TT=9) at each SNP shared across all users.'
          : 'Insufficient data for genotype clustering (need ≥2 users with shared matched variants).'}
      </div>
    </div>

    ${genotypeMatrixResult ? `
      <div class="mb-2">
        <strong>Cluster by:</strong>
        <div class="btn-group ms-2" role="group">
          <button id="genotypeClusterRowsBtn" class="btn btn-sm ${genotypeClusterRows ? 'btn-primary' : 'btn-outline-primary'}">Rows (Users)</button>
          <button id="genotypeClusterColsBtn" class="btn btn-sm ${genotypeClusterCols ? 'btn-primary' : 'btn-outline-primary'}">Columns (SNPs)</button>
          <button id="genotypeClusterBothBtn" class="btn btn-sm ${genotypeClusterRows && genotypeClusterCols ? 'btn-success' : 'btn-outline-success'}">Both</button>
        </div>
      </div>
      <div class="mb-2">
        <strong>Linkage:</strong>
        <div class="btn-group ms-2" role="group">
          <button id="genotypeMethodComplete" class="btn btn-sm ${genotypeClusterMethod === 'complete' ? 'btn-secondary' : 'btn-outline-secondary'}">Complete</button>
          <button id="genotypeMethodSingle" class="btn btn-sm ${genotypeClusterMethod === 'single' ? 'btn-secondary' : 'btn-outline-secondary'}">Single</button>
          <button id="genotypeMethodAverage" class="btn btn-sm ${genotypeClusterMethod === 'average' ? 'btn-secondary' : 'btn-outline-secondary'}">Average</button>
          <button id="genotypeMethodWard" class="btn btn-sm ${genotypeClusterMethod === 'ward' ? 'btn-secondary' : 'btn-outline-secondary'}">Ward</button>
        </div>
      </div>
      <div class="mb-3">
        <strong>Distance:</strong>
        <div class="btn-group ms-2" role="group">
          <button id="genotypeDistEuclidean" class="btn btn-sm ${genotypeClusterDistance === 'euclidean' ? 'btn-info' : 'btn-outline-info'}">Euclidean</button>
          <button id="genotypeDistManhattan" class="btn btn-sm ${genotypeClusterDistance === 'manhattan' ? 'btn-info' : 'btn-outline-info'}">Manhattan</button>
        </div>
      </div>
      <div class="card mb-4">
        <div class="card-header d-flex justify-content-between align-items-center">
          <span><strong>Users × SNPs Allele Count Heatmap</strong> <span class="text-muted small">— ${genotypeMatrixResult.userIds.length} users × ${genotypeMatrixResult.snpCount} shared SNPs (all PGS combined)</span></span>
          <button id="genotypeDownloadBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>
        </div>
        <div class="card-body">
          <div id="genotypeDistPlot" style="min-height: 400px; display: flex; align-items: center; justify-content: center;">
            <div class="text-muted small">
              <div class="spinner-border spinner-border-sm mb-2" role="status"></div>
              <div>Rendering heatmap...</div>
            </div>
          </div>
        </div>
      </div>
    ` : `<div class="alert alert-warning mb-3">Cannot generate genotype clustering. Check that multiple users have loaded genome data with matched variants.</div>`}

    </div>

    <div id="clusterSectionF" style="display:${activeClusterSection === 'F' ? 'block' : 'none'};">
    <div class="card mb-4">
      <div class="card-header">
        <strong>F. Genome-wide User × SNP Genotype Clustering</strong>
        <span class="text-muted small">— raw 23andMe files only</span>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">
          Cluster users by genotype patterns across SNPs shared in all loaded 23andMe files.
          This does not use PGS models, PRS scores, or effect weights.
        </p>
        <div class="mb-2">
          <strong>Cluster by:</strong>
          <div class="btn-group ms-2" role="group">
            <button id="rawGenoClusterRowsBtn" class="btn btn-sm btn-primary">Rows (Users)</button>
            <button id="rawGenoClusterColsBtn" class="btn btn-sm btn-outline-primary">Cols (SNPs)</button>
            <button id="rawGenoClusterBothBtn" class="btn btn-sm btn-outline-success">Both</button>
            <button id="rawGenoClusterNoneBtn" class="btn btn-sm btn-outline-secondary">None</button>
          </div>
          <span class="text-muted small ms-2">Column clustering is slow with many SNPs.</span>
        </div>
        <div class="mb-2">
          <strong>Linkage:</strong>
          <div class="btn-group ms-2" role="group">
            <button id="rawGenoMethodComplete" class="btn btn-sm btn-secondary">Complete</button>
            <button id="rawGenoMethodSingle"   class="btn btn-sm btn-outline-secondary">Single</button>
            <button id="rawGenoMethodAverage"  class="btn btn-sm btn-outline-secondary">Average</button>
            <button id="rawGenoMethodWard"     class="btn btn-sm btn-outline-secondary">Ward</button>
          </div>
        </div>
        <div class="mb-2">
          <strong>Distance:</strong>
          <div class="btn-group ms-2" role="group">
            <button id="rawGenoDistEuclidean" class="btn btn-sm btn-info">Euclidean</button>
            <button id="rawGenoDistManhattan" class="btn btn-sm btn-outline-info">Manhattan</button>
          </div>
        </div>
        <div class="mb-3">
          <strong>Max SNPs:</strong>
          <div class="btn-group ms-2" role="group">
            <button id="rawGenoMaxSnps500"  class="btn btn-sm btn-secondary">500</button>
            <button id="rawGenoMaxSnps1k"   class="btn btn-sm btn-outline-secondary">1 k</button>
            <button id="rawGenoMaxSnps5k"   class="btn btn-sm btn-outline-secondary">5 k</button>
            <button id="rawGenoMaxSnps10k"  class="btn btn-sm btn-outline-secondary">10 k</button>
          </div>
          <span class="text-muted small ms-2">(evenly sampled; raise with caution)</span>
        </div>
        <div class="mb-2 small text-muted">
          <strong>Users available:</strong> ${(window.loadedUsers ?? []).length} loaded
          ${(window.loadedUsers ?? []).length === 0 ? '<span class="text-danger ms-1">(Load fallback users in the PRS tab first)</span>' : ''}
        </div>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <button id="runRawGenoBtn" class="btn btn-sm btn-warning">&#9654; Run genome-wide clustering</button>
          <button id="rawGenoBuildCsvBtn" class="btn btn-sm btn-outline-secondary">⬇ Build matrix &amp; download CSV</button>
          <span class="text-muted small">Clustering computes on click — not automatic.</span>
        </div>
        <div id="rawGenoStatus" class="text-muted small mt-2"></div>
        <div id="rawGenoDownloadWrap" class="mt-2" style="display:none">
          <button id="rawGenoDownloadBtn" class="btn btn-sm btn-outline-secondary">⬇ Download CSV</button>
          <span class="text-muted small ms-2" id="rawGenoDownloadLabel"></span>
        </div>
        <div id="rawGenoPlot" class="mt-3"></div>
      </div>
    </div>
    </div>
  `;

  // Section display handlers (A-F)
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((section) => {
    const btn = document.getElementById(`display${section}`);
    if (!btn) return;
    btn.onclick = () => {
      window.clusterOptions = { ...window.clusterOptions, activeClusterSection: section };
      renderCluster();
    };
  });

  // Download PRS matrix as JSON (ClustJS-compatible)
  document.getElementById('downloadPrsMatrixBtn').onclick = () => {
    const data = clusterCache.pivoted ?? pivotPrsResults(window.prsResults);
    if (!data) { alert('No PRS matrix available. Run a PRS calculation first.'); return; }
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prs_matrix.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Attach button handlers for PRS clustering
  document.getElementById('clusterRowsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterRows: !clusterRows, clusterCols };
    renderCluster();
  };
  document.getElementById('clusterColsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterRows, clusterCols: !clusterCols };
    renderCluster();
  };
  document.getElementById('clusterBothBtn').onclick = () => {
    const bothOn = clusterRows && clusterCols;
    window.clusterOptions = { ...window.clusterOptions, clusterRows: !bothOn, clusterCols: !bothOn };
    renderCluster();
  };

  // PRS clustering method handlers
  document.getElementById('clusterMethodComplete').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterMethod: 'complete' };
    renderCluster();
  };
  document.getElementById('clusterMethodSingle').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterMethod: 'single' };
    renderCluster();
  };
  document.getElementById('clusterMethodAverage').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterMethod: 'average' };
    renderCluster();
  };
  document.getElementById('clusterMethodWard').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterMethod: 'ward' };
    renderCluster();
  };

  // PRS clustering distance handlers
  document.getElementById('clusterDistEuclidean').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterDistance: 'euclidean' };
    renderCluster();
  };
  document.getElementById('clusterDistManhattan').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterDistance: 'manhattan' };
    renderCluster();
  };
  document.getElementById('clusterDistCosine').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterDistance: 'cosine' };
    renderCluster();
  };

  // Attach dropdown handler for PGS selection
  document.getElementById('pgsSelectDropdown').onchange = (e) => {
    window.clusterOptions = { ...window.clusterOptions, selectedPgsId: e.target.value };
    renderCluster();
  };

  // Attach dropdown handler for user selection (PGS vs SNPs)
  document.getElementById('userSelectDropdown').onchange = (e) => {
    window.clusterOptions = { ...window.clusterOptions, selectedUserId: e.target.value };
    renderCluster();
  };

  // PGS vs SNPs clustering button handlers
  document.getElementById('pgsVsSnpsRowsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, pgsVsSnpsClusterRows: !pgsVsSnpsClusterRows, pgsVsSnpsClusterCols };
    renderCluster();
  };
  document.getElementById('pgsVsSnpsColsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, pgsVsSnpsClusterRows, pgsVsSnpsClusterCols: !pgsVsSnpsClusterCols };
    renderCluster();
  };
  document.getElementById('pgsVsSnpsBothBtn').onclick = () => {
    const bothOn = pgsVsSnpsClusterRows && pgsVsSnpsClusterCols;
    window.clusterOptions = { ...window.clusterOptions, pgsVsSnpsClusterRows: !bothOn, pgsVsSnpsClusterCols: !bothOn };
    renderCluster();
  };

  // PGS × SNP Effect Weight clustering button handlers
  document.getElementById('effectClusterRowsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, effectClusterRows: !effectClusterRows, effectClusterCols };
    renderCluster();
  };
  document.getElementById('effectClusterColsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, effectClusterRows, effectClusterCols: !effectClusterCols };
    renderCluster();
  };
  document.getElementById('effectClusterBothBtn').onclick = () => {
    const bothOn = effectClusterRows && effectClusterCols;
    window.clusterOptions = { ...window.clusterOptions, effectClusterRows: !bothOn, effectClusterCols: !bothOn };
    renderCluster();
  };

  // Attach allele clustering button handlers
  document.getElementById('clusterAlleleRowsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterAlleleRows: !clusterAlleleRows, clusterAlleleCols };
    renderCluster();
  };
  document.getElementById('clusterAlleleColsBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, clusterAlleleRows, clusterAlleleCols: !clusterAlleleCols };
    renderCluster();
  };
  document.getElementById('clusterAlleleBothBtn').onclick = () => {
    const bothOn = clusterAlleleRows && clusterAlleleCols;
    window.clusterOptions = { ...window.clusterOptions, clusterAlleleRows: !bothOn, clusterAlleleCols: !bothOn };
    renderCluster();
  };

  // Allele clustering method handlers
  document.getElementById('alleleMethodComplete').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleClusterMethod: 'complete' };
    renderCluster();
  };
  document.getElementById('alleleMethodSingle').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleClusterMethod: 'single' };
    renderCluster();
  };
  document.getElementById('alleleMethodAverage').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleClusterMethod: 'average' };
    renderCluster();
  };
  document.getElementById('alleleMethodWard').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleClusterMethod: 'ward' };
    renderCluster();
  };

  // Allele clustering distance handlers
  document.getElementById('alleleDistEuclidean').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleClusterDistance: 'euclidean' };
    renderCluster();
  };
  document.getElementById('alleleDistManhattan').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleClusterDistance: 'manhattan' };
    renderCluster();
  };
  document.getElementById('alleleDistCosine').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleClusterDistance: 'cosine' };
    renderCluster();
  };

  document.getElementById('alleleValueAlleleBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleValueMode: 'allele' };
    renderCluster();
  };
  document.getElementById('alleleValueRiskXAlleleBtn').onclick = () => {
    window.clusterOptions = { ...window.clusterOptions, alleleValueMode: 'risk_x_allele' };
    renderCluster();
  };

  // Genotype clustering button handlers (Section E)
  const ensureGenotypeButtons = () => {
    const btn1 = document.getElementById('genotypeClusterRowsBtn');
    if (!btn1) return; // Section E not rendered
    btn1.onclick = () => { window.clusterOptions = { ...window.clusterOptions, genotypeClusterRows: !genotypeClusterRows }; renderCluster(); };
    const btn2 = document.getElementById('genotypeClusterColsBtn');
    if (btn2) btn2.onclick = () => { window.clusterOptions = { ...window.clusterOptions, genotypeClusterCols: !genotypeClusterCols }; renderCluster(); };
    const btn3 = document.getElementById('genotypeClusterBothBtn');
    if (btn3) btn3.onclick = () => {
      const bothOn = genotypeClusterRows && genotypeClusterCols;
      window.clusterOptions = { ...window.clusterOptions, genotypeClusterRows: !bothOn, genotypeClusterCols: !bothOn };
      renderCluster();
    };
    const btnEuc = document.getElementById('genotypeDistEuclidean');
    if (btnEuc) btnEuc.onclick = () => { window.clusterOptions = { ...window.clusterOptions, genotypeClusterDistance: 'euclidean' }; renderCluster(); };
    const btnMan = document.getElementById('genotypeDistManhattan');
    if (btnMan) btnMan.onclick = () => { window.clusterOptions = { ...window.clusterOptions, genotypeClusterDistance: 'manhattan' }; renderCluster(); };
  };

  // Genotype clustering linkage handlers
  const ensureGenotypeMethodButtons = () => {
    const btnComplete = document.getElementById('genotypeMethodComplete');
    const btnSingle = document.getElementById('genotypeMethodSingle');
    const btnAverage = document.getElementById('genotypeMethodAverage');
    const btnWard = document.getElementById('genotypeMethodWard');
    if (!btnComplete) return;

    btnComplete.onclick = () => {
      window.clusterOptions = { ...window.clusterOptions, genotypeClusterMethod: 'complete' };
      renderCluster();
    };
    btnSingle.onclick = () => {
      window.clusterOptions = { ...window.clusterOptions, genotypeClusterMethod: 'single' };
      renderCluster();
    };
    btnAverage.onclick = () => {
      window.clusterOptions = { ...window.clusterOptions, genotypeClusterMethod: 'average' };
      renderCluster();
    };
    btnWard.onclick = () => {
      window.clusterOptions = { ...window.clusterOptions, genotypeClusterMethod: 'ward' };
      renderCluster();
    };
  };

  ensureGenotypeButtons();
  ensureGenotypeMethodButtons();

  // Wire Section E download button
  const genotypeDownloadBtn = document.getElementById('genotypeDownloadBtn');
  if (genotypeDownloadBtn) {
    genotypeDownloadBtn.onclick = () => {
      downloadMatrixAsCsv(genotypeMatrix, `genotype_matrix_E_${genotypeMatrixResult.snpCount}snps.csv`);
    };
  }

  // Wire Section A CSV download
  const downloadPrsCsvBtn = document.getElementById('downloadPrsCsvBtn');
  if (downloadPrsCsvBtn) {
    downloadPrsCsvBtn.onclick = () => {
      const data = clusterCache.pivoted ?? pivotPrsResults(window.prsResults);
      if (!data) { alert('No PRS matrix available.'); return; }
      downloadMatrixAsCsv(data, `prs_matrix_A_${data.length}users.csv`);
    };
  }

  // Wire Section B CSV downloads
  const downloadBAllBtn = document.getElementById('downloadBAllBtn');
  if (downloadBAllBtn && allMatrix) downloadBAllBtn.onclick = () => downloadMatrixAsCsv(allMatrix, `allele_matrix_B_all_${selectedPgsId}.csv`);
  const downloadBOverlapBtn = document.getElementById('downloadBOverlapBtn');
  if (downloadBOverlapBtn && overlapMatrix) downloadBOverlapBtn.onclick = () => downloadMatrixAsCsv(overlapMatrix, `allele_matrix_B_overlap_${selectedPgsId}.csv`);
  const downloadBSharedBtn = document.getElementById('downloadBSharedBtn');
  if (downloadBSharedBtn && sharedMatrix) downloadBSharedBtn.onclick = () => downloadMatrixAsCsv(sharedMatrix, `allele_matrix_B_shared_${selectedPgsId}.csv`);

  // Wire Section C CSV downloads
  const downloadCAllBtn = document.getElementById('downloadCAllBtn');
  if (downloadCAllBtn && pgsVsSnpsAllMatrix) downloadCAllBtn.onclick = () => downloadMatrixAsCsv(pgsVsSnpsAllMatrix, `pgs_snp_matrix_C_all_${selectedUserId}.csv`);
  const downloadCOverlapBtn = document.getElementById('downloadCOverlapBtn');
  if (downloadCOverlapBtn && pgsVsSnpsOverlapMatrix) downloadCOverlapBtn.onclick = () => downloadMatrixAsCsv(pgsVsSnpsOverlapMatrix, `pgs_snp_matrix_C_overlap_${selectedUserId}.csv`);
  const downloadCSharedBtn = document.getElementById('downloadCSharedBtn');
  if (downloadCSharedBtn && pgsVsSnpsSharedMatrix) downloadCSharedBtn.onclick = () => downloadMatrixAsCsv(pgsVsSnpsSharedMatrix, `pgs_snp_matrix_C_shared_${selectedUserId}.csv`);

  // Wire Section D CSV downloads
  const downloadDAllBtn = document.getElementById('downloadDAllBtn');
  if (downloadDAllBtn && pgsEffectAll?.data) downloadDAllBtn.onclick = () => downloadMatrixAsCsv(pgsEffectAll.data, `effect_matrix_D_all_${pgsEffectAll.pgsCount}pgs.csv`);
  const downloadDOverlapBtn = document.getElementById('downloadDOverlapBtn');
  if (downloadDOverlapBtn && pgsEffectOverlap?.data) downloadDOverlapBtn.onclick = () => downloadMatrixAsCsv(pgsEffectOverlap.data, `effect_matrix_D_overlap_${pgsEffectOverlap.pgsCount}pgs.csv`);
  const downloadDSharedBtn = document.getElementById('downloadDSharedBtn');
  if (downloadDSharedBtn && pgsEffectShared?.data) downloadDSharedBtn.onclick = () => downloadMatrixAsCsv(pgsEffectShared.data, `effect_matrix_D_shared_${pgsEffectShared.pgsCount}pgs.csv`);

  // Section F — lazy-loaded on button click
  // Local state for Section F options (persisted on window.clusterOptions)
  const syncRawGenoButtons = () => {
    const cr = window.clusterOptions?.rawGenoClusterRows ?? true;
    const cc = window.clusterOptions?.rawGenoClusterCols ?? false;
    const method = window.clusterOptions?.rawGenoMethod ?? 'complete';
    const dist   = window.clusterOptions?.rawGenoDist   ?? 'euclidean';
    const maxSnps = window.clusterOptions?.rawGenoMaxSnps ?? 500;

    const setActive = (id, active) => {
      const el = document.getElementById(id);
      if (!el) return;
      // swap between active/outline variants by toggling class lists
      const cls = el.className.replace('btn-outline-', '__OUT__').replace('btn-', '').replace('__OUT__', 'outline-');
      // simpler: just force the known classes
    };

    // Cluster-by buttons
    const rb = document.getElementById('rawGenoClusterRowsBtn');
    const cb = document.getElementById('rawGenoClusterColsBtn');
    const bb = document.getElementById('rawGenoClusterBothBtn');
    const nb = document.getElementById('rawGenoClusterNoneBtn');
    if (rb) rb.className = `btn btn-sm ${cr && !cc ? 'btn-primary' : 'btn-outline-primary'}`;
    if (cb) cb.className = `btn btn-sm ${!cr && cc ? 'btn-primary' : 'btn-outline-primary'}`;
    if (bb) bb.className = `btn btn-sm ${cr && cc  ? 'btn-success' : 'btn-outline-success'}`;
    if (nb) nb.className = `btn btn-sm ${!cr && !cc ? 'btn-secondary' : 'btn-outline-secondary'}`;

    // Method
    ['complete','single','average','ward'].forEach(m => {
      const el = document.getElementById(`rawGenoMethod${m.charAt(0).toUpperCase()+m.slice(1)}`);
      if (el) el.className = `btn btn-sm ${method === m ? 'btn-secondary' : 'btn-outline-secondary'}`;
    });

    // Distance
    const de = document.getElementById('rawGenoDistEuclidean');
    const dm = document.getElementById('rawGenoDistManhattan');
    if (de) de.className = `btn btn-sm ${dist === 'euclidean' ? 'btn-info' : 'btn-outline-info'}`;
    if (dm) dm.className = `btn btn-sm ${dist === 'manhattan' ? 'btn-info' : 'btn-outline-info'}`;

    // Max SNPs
    [['rawGenoMaxSnps500',500],['rawGenoMaxSnps1k',1000],['rawGenoMaxSnps5k',5000],['rawGenoMaxSnps10k',10000]].forEach(([id,n]) => {
      const el = document.getElementById(id);
      if (el) el.className = `btn btn-sm ${maxSnps === n ? 'btn-secondary' : 'btn-outline-secondary'}`;
    });
  };
  syncRawGenoButtons();

  const bindRawGenoOption = (id, optKey, val) => {
    const el = document.getElementById(id);
    if (el) el.onclick = () => { window.clusterOptions = { ...window.clusterOptions, [optKey]: val }; syncRawGenoButtons(); };
  };

  // Cluster-by
  const rawGenoRowsBtn = document.getElementById('rawGenoClusterRowsBtn');
  const rawGenoColsBtn = document.getElementById('rawGenoClusterColsBtn');
  const rawGenoBothBtn = document.getElementById('rawGenoClusterBothBtn');
  const rawGenoNoneBtn = document.getElementById('rawGenoClusterNoneBtn');
  if (rawGenoRowsBtn) rawGenoRowsBtn.onclick = () => { window.clusterOptions = { ...window.clusterOptions, rawGenoClusterRows: true,  rawGenoClusterCols: false }; syncRawGenoButtons(); };
  if (rawGenoColsBtn) rawGenoColsBtn.onclick = () => { window.clusterOptions = { ...window.clusterOptions, rawGenoClusterRows: false, rawGenoClusterCols: true  }; syncRawGenoButtons(); };
  if (rawGenoBothBtn) rawGenoBothBtn.onclick = () => { window.clusterOptions = { ...window.clusterOptions, rawGenoClusterRows: true,  rawGenoClusterCols: true  }; syncRawGenoButtons(); };
  if (rawGenoNoneBtn) rawGenoNoneBtn.onclick = () => { window.clusterOptions = { ...window.clusterOptions, rawGenoClusterRows: false, rawGenoClusterCols: false }; syncRawGenoButtons(); };

  // Method
  bindRawGenoOption('rawGenoMethodComplete', 'rawGenoMethod', 'complete');
  bindRawGenoOption('rawGenoMethodSingle',   'rawGenoMethod', 'single');
  bindRawGenoOption('rawGenoMethodAverage',  'rawGenoMethod', 'average');
  bindRawGenoOption('rawGenoMethodWard',     'rawGenoMethod', 'ward');

  // Distance
  bindRawGenoOption('rawGenoDistEuclidean', 'rawGenoDist', 'euclidean');
  bindRawGenoOption('rawGenoDistManhattan', 'rawGenoDist', 'manhattan');

  // Max SNPs
  bindRawGenoOption('rawGenoMaxSnps500',  'rawGenoMaxSnps', 500);
  bindRawGenoOption('rawGenoMaxSnps1k',   'rawGenoMaxSnps', 1000);
  bindRawGenoOption('rawGenoMaxSnps5k',   'rawGenoMaxSnps', 5000);
  bindRawGenoOption('rawGenoMaxSnps10k',  'rawGenoMaxSnps', 10000);

  const runRawGenoBtn = document.getElementById('runRawGenoBtn');
  if (runRawGenoBtn) {
    runRawGenoBtn.onclick = async () => {
      const status  = document.getElementById('rawGenoStatus');
      const plotDiv = document.getElementById('rawGenoPlot');
      if (plotDiv) plotDiv.innerHTML  = '';
      await new Promise(resolve => requestAnimationFrame(resolve));

      const rawGenoMaxSnps   = window.clusterOptions?.rawGenoMaxSnps   ?? 500;
      const rawGenoClusterRows = window.clusterOptions?.rawGenoClusterRows ?? true;
      const rawGenoClusterCols = window.clusterOptions?.rawGenoClusterCols ?? false;
      const rawGenoMethod    = window.clusterOptions?.rawGenoMethod    ?? 'complete';
      const rawGenoDist      = window.clusterOptions?.rawGenoDist      ?? 'euclidean';

      // Build a cache key from user IDs + maxSnps — skip expensive rebuild if unchanged
      const rawGenoCacheKey = `${(window.loadedUsers ?? []).map(u => u.user?.id ?? u.user?.participant_id).join(',')}-${rawGenoMaxSnps}`;
      let rawGenoResult;
      if (clusterCache.rawGenoMatrix?.cacheKey === rawGenoCacheKey) {
        console.log('[F] Using cached matrix');
        rawGenoResult = clusterCache.rawGenoMatrix.result;
      } else {
        if (status) status.textContent = 'Building genome-wide shared SNP matrix…';
        await new Promise(resolve => requestAnimationFrame(resolve));
        console.time('[F] buildRawGenotypeMatrix');
        rawGenoResult = buildRawGenotypeMatrix(window.loadedUsers, { maxSnps: rawGenoMaxSnps, missingValue: -1 });
        console.timeEnd('[F] buildRawGenotypeMatrix');
        clusterCache.rawGenoMatrix = { cacheKey: rawGenoCacheKey, result: rawGenoResult };
      }

      if (!rawGenoResult) {
        if (status) status.textContent = 'No raw genotype matrix could be generated. Make sure multiple users are loaded.';
        return;
      }

      console.log(`[F] matrix: ${rawGenoResult.userIds.length} users × ${rawGenoResult.snpCount} SNPs, clusterRows=${rawGenoClusterRows}, clusterCols=${rawGenoClusterCols}`);

      // Show download button immediately after matrix is built
      const wrap  = document.getElementById('rawGenoDownloadWrap');
      const dlBtn = document.getElementById('rawGenoDownloadBtn');
      const dlLbl = document.getElementById('rawGenoDownloadLabel');
      if (wrap)  wrap.style.display = '';
      if (dlLbl) dlLbl.textContent = `${rawGenoResult.snpCount.toLocaleString()} SNPs × ${rawGenoResult.userIds.length} users`;
      if (dlBtn) dlBtn.onclick = () => {
        downloadMatrixAsCsv(rawGenoResult.matrix, `raw_genotype_matrix_F_${rawGenoResult.snpCount}snps.csv`);
      };

      if (status) {
        status.textContent =
          `${rawGenoResult.userIds.length} users × ${rawGenoResult.snpCount.toLocaleString()} SNPs shown` +
          (rawGenoResult.totalSharedSnps > rawGenoResult.snpCount
            ? ` (evenly sampled from ${rawGenoResult.totalSharedSnps.toLocaleString()} shared SNPs)`
            : ` (${rawGenoResult.totalSharedSnps.toLocaleString()} total shared SNPs)`) + '.';
      }

      const genotypeColorScale = clust.d3.scaleLinear()
        .domain([-1, 0, 9])
        .range(['#000000', '#f7fbff', '#08306b']);

      console.time('[F] hclust_plot');
      await clust.hclust_plot({
         divId:  'rawGenoPlot',
        data:  rawGenoResult.matrix,
        width: 1000,
        height: 400,
        clusterRows: rawGenoClusterRows,
        clusterCols: rawGenoClusterCols,
        heatmapColorScale: genotypeColorScale,
        clusteringMethodRows: rawGenoMethod,
        clusteringMethodCols: rawGenoMethod,
        clusteringDistanceRows: rawGenoDist,
        clusteringDistanceCols: rawGenoDist
      });
      console.timeEnd('[F] hclust_plot');
    };
  }

  // Wire "Build & Download CSV" button — builds matrix only, no render
  const rawGenoBuildCsvBtn = document.getElementById('rawGenoBuildCsvBtn');
  if (rawGenoBuildCsvBtn) {
    rawGenoBuildCsvBtn.onclick = async () => {
      const status = document.getElementById('rawGenoStatus');
      const rawGenoMaxSnps = window.clusterOptions?.rawGenoMaxSnps ?? 500;
      const rawGenoCacheKey = `${(window.loadedUsers ?? []).map(u => u.user?.id ?? u.user?.participant_id).join(',')}-${rawGenoMaxSnps}`;
      let rawGenoResult;
      if (clusterCache.rawGenoMatrix?.cacheKey === rawGenoCacheKey) {
        rawGenoResult = clusterCache.rawGenoMatrix.result;
      } else {
        if (status) status.textContent = 'Building matrix…';
        await new Promise(resolve => requestAnimationFrame(resolve));
        rawGenoResult = buildRawGenotypeMatrix(window.loadedUsers, { maxSnps: rawGenoMaxSnps, missingValue: -1 });
        clusterCache.rawGenoMatrix = { cacheKey: rawGenoCacheKey, result: rawGenoResult };
      }
      if (!rawGenoResult) {
        if (status) status.textContent = 'No raw genotype matrix could be generated. Make sure multiple users are loaded.';
        return;
      }
      if (status) status.textContent = `${rawGenoResult.userIds.length} users × ${rawGenoResult.snpCount.toLocaleString()} SNPs.`;
      const wrap  = document.getElementById('rawGenoDownloadWrap');
      const dlBtn = document.getElementById('rawGenoDownloadBtn');
      const dlLbl = document.getElementById('rawGenoDownloadLabel');
      if (wrap)  wrap.style.display = '';
      if (dlLbl) dlLbl.textContent = `${rawGenoResult.snpCount.toLocaleString()} SNPs × ${rawGenoResult.userIds.length} users`;
      if (dlBtn) dlBtn.onclick = () => {
        downloadMatrixAsCsv(rawGenoResult.matrix, `raw_genotype_matrix_F_${rawGenoResult.snpCount}snps.csv`);
      };
      downloadMatrixAsCsv(rawGenoResult.matrix, `raw_genotype_matrix_F_${rawGenoResult.snpCount}snps.csv`);
    };
  }

  if (betaContributionByUser.length > 0 && typeof Plotly !== 'undefined') {
    betaContributionByUser.forEach((u, idx) => {
      const matchedAbs = Math.abs(u.matchedBeta);
      const unmatchedAbs = Math.abs(u.unmatchedBeta);
      const hasData = matchedAbs > 0 || unmatchedAbs > 0;
      if (!hasData) return;

      Plotly.newPlot(`betaContributionPieUser_${idx}`, [{
        values: [matchedAbs, unmatchedAbs],
        labels: [
          `Matched (n=${u.matchedCount})`,
          `Unmatched (n=${u.unmatchedCount})`
        ],
        textinfo: 'percent',
        textposition: 'outside',
        type: 'pie',
        marker: {
          colors: ['#2ca02c', 'grey'],
          line: { color: 'black' }
        },
        hovertemplate: '%{label}<br>|Σβ|=%{value:.4f}<extra></extra>'
      }], {
        margin: { t: 24, r: 24, b: 24, l: 24 },
        showlegend: false
      }, {
        responsive: true,
        displayModeBar: false
      });
    });
  }

  // A. Render PRS cluster plot
  //console.log('[Section A] pivoted:', JSON.stringify(pivoted), 'divEl:', document.getElementById('clusterPlotMount'));
  try {
    await clust.hclust_plot({
       divId:  "clusterPlotMount",
      data: pivoted,
      width: 900,
      height: 350,
      clusterRows: clusterRows,
      clusterCols: clusterCols,
      clusteringMethodRows: clusterMethod,
      clusteringMethodCols: clusterMethod,
      clusteringDistanceRows: clusterDistance,
      clusteringDistanceCols: clusterDistance
    });
  } catch(e) { console.error('[Section A] hclust_plot error:', e); }

  const colorScale = clust.d3.scaleLinear().domain([0, 1, 2]).range(["#f7fbff", "#6baed6", "#103a79"]);

  const getMatrixValues = (matrix) => {
    if (!Array.isArray(matrix)) return [];
    return matrix.flatMap(row =>
      Object.entries(row)
        .filter(([k]) => k !== 'label')
        .map(([, v]) => v)
        .filter(Number.isFinite)
    );
  };

  const alleleValueScale = (() => {
    const vals = [
      ...getMatrixValues(allMatrix),
      ...getMatrixValues(overlapMatrix),
      ...getMatrixValues(sharedMatrix)
    ];
    if (!vals.length) return colorScale;

    if (alleleValueMode === 'risk_x_allele') {
      const maxAbs = Math.max(...vals.map(v => Math.abs(v)), 0.01);
      return clust.d3.scaleLinear()
        .domain([-maxAbs, 0, maxAbs])
        .range(["#66bc66", "#ffffff", "#9e0606"]);
    }

    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals);
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || minVal === maxVal) {
      return colorScale;
    }

    return clust.d3.scaleLinear()
      .domain([minVal, (minVal + maxVal) / 2, maxVal])
      .range(["#f7fbff", "#d66b6b", "#840505"]);
  })();
  const greenColorScale = clust.d3.scaleLinear().domain([0, 1, 2]).range(["#f7fcf5", "#74c476", "#006d2c"]);

  // B. Render 1. All Variants plot
  if (allMatrix) {
    await clust.hclust_plot({
       divId:  "allVariantsPlot",
      data: allMatrix,
      displayData: allMatrixDisplay,
      width: 900,
      height: 350,
      clusterRows: clusterAlleleRows,
      clusterCols: clusterAlleleCols,
      heatmapColorScale: alleleValueScale,
      clusteringMethodRows: alleleClusterMethod,
      clusteringMethodCols: alleleClusterMethod,
      clusteringDistanceRows: alleleClusterDistance,
      clusteringDistanceCols: alleleClusterDistance
    });
  }

  // B. Render 2. Overlapping Matches plot
  if (overlapMatrix) {
    await clust.hclust_plot({
       divId:  "overlapPlot",
      data: overlapMatrix,
      displayData: overlapMatrixDisplay,
      width: 900,
      height: 350,
      clusterRows: clusterAlleleRows,
      clusterCols: clusterAlleleCols,
      heatmapColorScale: alleleValueScale,
      clusteringMethodRows: alleleClusterMethod,
      clusteringMethodCols: alleleClusterMethod,
      clusteringDistanceRows: alleleClusterDistance,
      clusteringDistanceCols: alleleClusterDistance
    });
  }

  // B. Render 3. Shared Matched SNPs plot
  if (sharedMatrix && Object.keys(sharedMatrix[0]).length > 1) {
    await clust.hclust_plot({
       divId:  "sharedPlot",
      data: sharedMatrix,
      displayData: sharedMatrixDisplay,
      width: 900,
      height: 350,
      clusterRows: clusterAlleleRows,
      clusterCols: clusterAlleleCols,
      heatmapColorScale: alleleValueScale,
      clusteringMethodRows: alleleClusterMethod,
      clusteringMethodCols: alleleClusterMethod,
      clusteringDistanceRows: alleleClusterDistance,
      clusteringDistanceCols: alleleClusterDistance
    });
  } else if (document.getElementById("sharedPlot")) {
    document.getElementById("sharedPlot").innerHTML =
      `<div class="alert alert-info">No SNPs shared across all users.</div>`;
  }

  // C. Render PGS vs SNPs plots (three views)
  if (pgsVsSnpsAllMatrix && pgsVsSnpsAllMatrix.length >= 2) {
    await clust.hclust_plot({
       divId:  "pgsVsSnpsAllPlot",
      data: pgsVsSnpsAllMatrix,
      displayData: pgsVsSnpsAllMatrixDisplay,
      width: 900,
      height: 350,
      clusterRows: pgsVsSnpsClusterRows,
      clusterCols: pgsVsSnpsClusterCols,
      heatmapColorScale: greenColorScale,
      clusteringMethodRows: alleleClusterMethod,
      clusteringMethodCols: alleleClusterMethod,
      clusteringDistanceRows: alleleClusterDistance,
      clusteringDistanceCols: alleleClusterDistance
    });
  }

  if (pgsVsSnpsOverlapMatrix && pgsVsSnpsOverlapMatrix.length >= 2) {
    await clust.hclust_plot({
       divId:  "pgsVsSnpsOverlapPlot",
      data: pgsVsSnpsOverlapMatrix,
      displayData: pgsVsSnpsOverlapMatrixDisplay,
      width: 900,
      height: 350,
      clusterRows: pgsVsSnpsClusterRows,
      clusterCols: pgsVsSnpsClusterCols,
      heatmapColorScale: greenColorScale,
      clusteringMethodRows: alleleClusterMethod,
      clusteringMethodCols: alleleClusterMethod,
      clusteringDistanceRows: alleleClusterDistance,
      clusteringDistanceCols: alleleClusterDistance
    });
  }

  if (pgsVsSnpsSharedMatrix && pgsVsSnpsSharedMatrix.length >= 2 && Object.keys(pgsVsSnpsSharedMatrix[0]).length > 1) {
    await clust.hclust_plot({
       divId:  "pgsVsSnpsSharedPlot",
      data: pgsVsSnpsSharedMatrix,
      displayData: pgsVsSnpsSharedMatrixDisplay,
      width: 900,
      height: 350,
      clusterRows: pgsVsSnpsClusterRows,
      clusterCols: pgsVsSnpsClusterCols,
      heatmapColorScale: greenColorScale,
      clusteringMethodRows: alleleClusterMethod,
      clusteringMethodCols: alleleClusterMethod,
      clusteringDistanceRows: alleleClusterDistance,
      clusteringDistanceCols: alleleClusterDistance
    });
  }

  // Color scale for effect weights (diverging: negative = blue, zero = white, positive = red)
  // Dynamically calculate domain based on actual data range
  const extractValues = (dataArr) => {
    if (!dataArr) return [];
    return dataArr.flatMap(row => 
      Object.entries(row).filter(([k]) => k !== 'label').map(([, v]) => v)
    );
  };
  const allEffectValues = [
    ...extractValues(pgsEffectAll?.data),
    ...extractValues(pgsEffectOverlap?.data),
    ...extractValues(pgsEffectShared?.data)
  ].filter(Number.isFinite);
  

  // max absolute effect size across your data (using tighter percentiles for better contrast)
  const percentile = (arr, p) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
    return sorted[idx];
  };

  const effectExtent = allEffectValues.length > 0
    ? Math.max(
        Math.abs(percentile(allEffectValues, 0.15)),
        Math.abs(percentile(allEffectValues, 0.85)),
        0.1
      )
    : 2;

  const effectColorScale = clust.d3.scaleLinear()
    .domain([-effectExtent, 0, effectExtent])
    .range(["#2166ac", "#f7f7f7", "#b2182b"]);
    
  // D. Render PGS Effect Weight plots (All, Overlapping, Shared)
  if (pgsEffectAll && pgsEffectAll.data.length >= 2) {
    await clust.hclust_plot({
       divId:  "pgsEffectAllPlot",
      data: pgsEffectAll.data,
      displayData: pgsEffectAll.displayData,
      width: 900,
      height: 350,
      clusterRows: effectClusterRows,
      clusterCols: effectClusterCols,
      heatmapColorScale: effectColorScale,
      clusteringMethodRows: clusterMethod,
      clusteringMethodCols: clusterMethod,
      clusteringDistanceRows: clusterDistance,
      clusteringDistanceCols: clusterDistance
    });
  }

  if (pgsEffectOverlap && pgsEffectOverlap.data.length >= 2) {
    await clust.hclust_plot({
       divId:  "pgsEffectOverlapPlot",
      data: pgsEffectOverlap.data,
      displayData: pgsEffectOverlap.displayData,
      width: 900,
      height: 350,
      clusterRows: effectClusterRows,
      clusterCols: effectClusterCols,
      heatmapColorScale: effectColorScale,
      clusteringMethodRows: clusterMethod,
      clusteringMethodCols: clusterMethod,
      clusteringDistanceRows: clusterDistance,
      clusteringDistanceCols: clusterDistance
    });
  }

  if (pgsEffectShared && pgsEffectShared.data.length >= 2) {
    await clust.hclust_plot({
       divId:  "pgsEffectSharedPlot",
      data: pgsEffectShared.data,
      displayData: pgsEffectShared.displayData,
      width: 900,
      height: 350,
      clusterRows: effectClusterRows,
      clusterCols: effectClusterCols,
      heatmapColorScale: effectColorScale,
      clusteringMethodRows: clusterMethod,
      clusteringMethodCols: clusterMethod,
      clusteringDistanceRows: clusterDistance,
      clusteringDistanceCols: clusterDistance
    });
  }

  // E. Render Section E: Genotype allele count heatmap (users × shared SNPs)
  if (genotypeMatrix) {
    // Genotype codes 0–9: AA AC AG AT CC CG CT GG GT TT
    const genotypeColorScale = clust.d3.scaleLinear()
      .domain([0, 4, 9])
      .range(["#f7fbff", "#6baed6", "#103a79"]);

    await clust.hclust_plot({
       divId:  "genotypeDistPlot",
      data: genotypeMatrix,
      width: 900,
      height: 350,
      clusterRows: genotypeClusterRows,
      clusterCols: genotypeClusterCols,
      heatmapColorScale: genotypeColorScale,
      clusteringMethodRows: genotypeClusterMethod,
      clusteringMethodCols: genotypeClusterMethod,
      clusteringDistanceRows: genotypeClusterDistance,
      clusteringDistanceCols: genotypeClusterDistance
    });
  }

}

window.renderCluster = renderCluster;

Object.defineProperty(window, "pivoted", {
  get() {
    return clusterCache.pivoted;
  },
  configurable: true,
});

Object.defineProperty(window, "clusterCache", {
  get() {
    return clusterCache;
  },
  configurable: true,
});

// --- window.sdk namespace (cluster) ---
window.sdk = Object.assign(window.sdk ?? {}, {
    renderCluster,
    invalidateClusterCache,
    getClusterCache: () => clusterCache,
});

// Add live getters for pivoted and clusterCache into window.sdk
Object.defineProperty(window.sdk, "pivoted", {
    get() { return clusterCache.pivoted; },
    configurable: true,
});
Object.defineProperty(window.sdk, "clusterCache", {
    get() { return clusterCache; },
    configurable: true,
});

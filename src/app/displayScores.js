import { fetchAllScores, fetchSomeScores, getScoresPerTrait, getScoresPerCategory, fetchTraits, getPgsTxt } from "../sdk/pgsSdk.js";

/*
 Module: displayScores.js
 Purpose: fetch PGS Catalog scores (prefer per-trait), normalize common
					SDK shapes, and render a paginated table of score entries.

 Data shapes handled:
 - `data.scoresPerTrait` may be an object-of-objects whose values are:
	 - arrays (direct lists),
	 - objects with `.scores` or `.items` arrays,
	 - wrapper objects with `.score` containing a single score or array.

 The code below builds a `traitScoresMap` keyed by trait name where each
 value is an array of plain score objects, then flattens and filters by
 `variants_number` before rendering.
*/

const pgsLoadingStatusEl = document.getElementById("pgsLoadingStatus");
const pgsProgressBar = document.getElementById("pgsProgressBar");

function setPgsLoadingStatus(message, isError = false, progress = 0) {
	if (pgsLoadingStatusEl) {
		pgsLoadingStatusEl.textContent = message;
		pgsLoadingStatusEl.classList.toggle("text-danger", isError);
		pgsLoadingStatusEl.classList.toggle("text-muted", !isError);
	}
	if (pgsProgressBar) {
		pgsProgressBar.style.width = `${progress}%`;
	}
}

let data = { scoresPerTrait: {} };
let data2 = { scoresPerCategory: {} };


// TODO combine all 3 steps below in pgs sdk!
try {
	// fetchTraits() must run first — it populates the pgs:trait-summary cache
	// that getScoresPerTrait() and getScoresPerCategory() depend on.
	setPgsLoadingStatus("Step 1/3 - Loading trait summary cache...", false, 10);
	await fetchTraits();

	// fetchAllScores() must run second — it populates pgs:all-score-summary cache.
	setPgsLoadingStatus("Step 2/3 - Loading all-score summary cache...", false, 40);
	await fetchAllScores();

	setPgsLoadingStatus("Step 3/3 - Loading scores per trait and category...", false, 70);
	const [scoresPerTrait, scoresPerCategory] = await Promise.all([
		getScoresPerTrait(),
		getScoresPerCategory(),
	]);

	data = scoresPerTrait ?? { scoresPerTrait: {} };
	data2 = scoresPerCategory ?? { scoresPerCategory: {} };
	setPgsLoadingStatus("PGS data loaded successfully.", false, 100);
} catch (error) {
	console.error("displayScores.js: failed to load/cache PGS scores", error);
	setPgsLoadingStatus(`Failed to load PGS scores: ${error.message}`, true, 0);
}

// Dynamic variant filter state
let variantMin = 100;
let variantMax = 400;
const ALL_VALUE = "__all_traits__";
const ROWS_PER_PAGE = 50;
const MAX_SELECTION = 10; // Max number of scores that can be selected at once for PRS calculation

// Module-level selected PGS IDs and scores (shared across renders)
const selectedPgsIds = new Set([]);
const selectedScoresMap = new Map(); // Map<id, scoreObject>

/** Get the currently selected PGS IDs. */
window.getSelectedPgsIds = () => Array.from(selectedPgsIds);

/** Get the currently selected scores with full metadata. */
window.getSelectedScores = () => Array.from(selectedScoresMap.values());

/** Clear all selected scores. */
window.clearSelectedScores = () => {
	selectedPgsIds.clear();
	selectedScoresMap.clear();
	updateGlobalSelectionCount();
	console.log("Cleared all selected scores");
	// Notify participants table of PGS selection change
	window.onPgsSelectionChange?.();
};

/** Update the global selection count display. */
function updateGlobalSelectionCount() {
	const el = document.getElementById("globalSelectionCount");
	if (el) el.textContent = `Selected: ${selectedPgsIds.size} / ${MAX_SELECTION}`;

	// Show/hide the contextual "Fetch PGS Files" button
	const fetchPgsFilesBtn = document.getElementById("fetchPgsFilesBtn");
	if (fetchPgsFilesBtn) {
		fetchPgsFilesBtn.style.display = selectedPgsIds.size > 0 ? "" : "none";
	}

	// Show/hide the "Unselect All" button
	const unselectAllModelsBtn = document.getElementById("unselectAllModelsBtn");
	if (unselectAllModelsBtn) {
		unselectAllModelsBtn.style.display = selectedPgsIds.size > 0 ? "" : "none";
	}

	// Also update PRS tab scores section (mirrors displayUsers.js behavior for prsUsersdiv/prsUsersAction)
	const prsScoresDiv = document.getElementById("prsScoresDiv");
	if (prsScoresDiv && selectedPgsIds.size > 0) {
		const scoreList = Array.from(selectedScoresMap.values())
			.map(s => s.id)
			.join(", ");
		prsScoresDiv.textContent = `${selectedPgsIds.size} model(s) selected: ${scoreList}`;
	}

	const prsScoresAction = document.getElementById("prsScoresAction");
	if (prsScoresAction && selectedPgsIds.size > 0) {
		const selectedArr = Array.from(selectedScoresMap.values());
		const rows = selectedArr.map((score, idx) => {
			const id = escapeHtml(score?.id ?? "");
			const name = escapeHtml(score?.name ?? "");
			const trait = escapeHtml(score?.trait_reported ?? "");
			const variants = escapeHtml(score?.variants_number ?? "");
			const date = escapeHtml(score?.date_release ?? "");
			return `
				<tr>
					<td>${idx + 1}</td>
					<td><input type="checkbox" class="form-check-input prs-select-cb" value="${id}" checked /></td>
					<td>${id}</td>
					<td>${name}</td>
					<td>${trait}</td>
					<td>${variants}</td>
					<td>${date}</td>
				</tr>`;
		}).join("");
		prsScoresAction.innerHTML = `
			<table class="table table-striped table-sm mt-3">
				<thead class="table-dark">
					<tr>
						<th>#</th>
						<th>Select</th>
						<th>PGS ID</th>
						<th>Name</th>
						<th>Trait</th>
						<th>Variants #</th>
						<th>Date</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>`;
	}
}

/** Check if a score passes the current variant filter. */
function passesVariantFilter(score) {
	const v = Number(score?.variants_number ?? score?.score?.variants_number ?? 0);
	return Number.isFinite(v) && v >= variantMin && v <= variantMax;
}
/**
 * Compare two score objects for stable sorting.
 * First compares the `trait_reported` string, then falls back to `id`.
 * @param {Object} a - First score object.
 * @param {Object} b - Second score object.
 * @returns {number} Negative if a < b, positive if a > b, zero if equal.
 */
function compareScores(a, b) {
	const traitA = (a?.trait_reported ?? "").toString();
	const traitB = (b?.trait_reported ?? "").toString();
	const traitCompare = traitA.localeCompare(traitB);
	if (traitCompare !== 0) return traitCompare;
	const idA = (a?.id ?? "").toString();
	const idB = (b?.id ?? "").toString();
	return idA.localeCompare(idB);
}

// CATEGORY SCORES -------------------------------------------
console.log((" CATEGORY SCORES --------------------------------"));
const categoryScoresMap = new Map(Object.entries(data2.scoresPerCategory ?? {}).map(([category, entry]) => {
	const scores = Array.isArray(entry?.scores)
		? entry.scores
		: Array.isArray(entry?.items)
		? entry.items
		: Array.isArray(entry)
		? entry
		: (entry?.score ? (Array.isArray(entry.score) ? entry.score : [entry.score]) : []);
	return [category, scores];
}));
const categories = Array.from(categoryScoresMap.keys()).sort((a, b) => a.localeCompare(b));

// Flatten values and expose category keys.
const allCategoryScoresRaw = Array.from(categoryScoresMap.values()).flat();

console.log(`displayScores.js: Loaded ${allCategoryScoresRaw.length} raw category scores across ${categoryScoresMap.size} categories`);
// Deduplicate by PGS ID (keep first occurrence)
const seenCategoryIds = new Set();
const allCategoryScores = allCategoryScoresRaw.filter((score) => {
	const id = score?.id ?? "";
	if (seenCategoryIds.has(id)) return false;
	seenCategoryIds.add(id);
	return true;
});
// console.log(`displayScores.js: Deduplicated category scores from ${allCategoryScoresRaw.length} to ${allCategoryScores.length}`,allCategoryScores.slice(0,10));
//console.log(`displayScores.js: Loaded ${allCategoryScores.length} PGS entries across ${categoryScoresMap.size} categories`,allCategoryScores);

/** Get category scores filtered by current variant range. */
function getFilteredCategoryScores() {
	return allCategoryScores.filter(passesVariantFilter).sort(compareScores);
}

// TRAIT SCORES -------------------------------------------
console.log((" TRAIT SCORES --------------------------------"));
const traitScoresMap = new Map(Object.entries(data.scoresPerTrait ?? {}).map(([trait, entry]) => {
	const scores = Array.isArray(entry?.scores)
		? entry.scores
		: Array.isArray(entry?.items)
		? entry.items
		: Array.isArray(entry)
		? entry
		: (entry?.score ? (Array.isArray(entry.score) ? entry.score : [entry.score]) : []);
	return [trait, scores];
}));
const traits = Array.from(traitScoresMap.keys()).sort((a, b) => a.localeCompare(b));

// Flatten values and expose trait keys.
const allTraitScoresRaw = Array.from(traitScoresMap.values()).flat();

console.log(`displayScores.js: Loaded ${allTraitScoresRaw.length} raw trait scores across ${traitScoresMap.size} traits`);
// Deduplicate by PGS ID (keep first occurrence)
const seenTraitIds = new Set();
const allTraitScores = allTraitScoresRaw.filter((score) => {
	const id = score?.id ?? "";
	if (seenTraitIds.has(id)) return false;
	seenTraitIds.add(id);
	return true;
});
// console.log(`displayScores.js: Deduplicated trait scores from ${allTraitScoresRaw.length} to ${allTraitScores.length}`,allTraitScores.slice(0,10));
// console.log(`displayScores.js: Loaded ${allTraitScores.length} PGS entries across ${traits.length} traits`,allTraitScores);

/** Get trait scores filtered by current variant range. */
function getFilteredTraitScores() {
	return allTraitScores.filter(passesVariantFilter).sort(compareScores);
}


/**
 * Escape a string for safe insertion into HTML.
 * Replaces special characters with their HTML entities.
 * @param {any} value - Value to escape; will be coerced to string.
 * @returns {string} Escaped string safe for HTML contexts.
 */
function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Render a paginated PGS table into the DOM.
 * Shows `ROWS_PER_PAGE` rows per page, supports select-all and per-row selection,
 * and renders pagination controls. The function mutates the `innerHTML` of
 * the element identified by `targetId`.
 * @param {Array<Object>} scores - Array of PGS score objects to display.
 * @param {string} targetId - ID of the container element for the table.
 * @param {string} title - Title text displayed above the table.
 * @param {string} key - Unique key used to build element IDs for controls.
 */
function renderPgsTable(scores, targetId, title, key) {
	const scoresDiv = document.getElementById(targetId);
	if (!scoresDiv) return;
	scoresDiv.style.display = "block";

	let currentPage = 1;
	const selectedIds = selectedPgsIds; // Use module-level set

	const renderPage = () => {
		const totalPages = Math.max(1, Math.ceil(scores.length / ROWS_PER_PAGE));
		currentPage = Math.min(Math.max(1, currentPage), totalPages);
		const startIndex = (currentPage - 1) * ROWS_PER_PAGE;
		const pageScores = scores.slice(startIndex, startIndex + ROWS_PER_PAGE);

		const rowsHtml = pageScores
			.map((score, index) => {
				const rawPgsId = (score?.id ?? "").toString();
				const pgsId = escapeHtml(rawPgsId);
				const rawName = (score?.name ?? "").toString();
				const displayNameRaw = rawName.length > 15 ? rawName.slice(0, 15) + "..." : rawName;
				const pgsName = escapeHtml(displayNameRaw);
				const pgsNameTitle = escapeHtml(rawName);
				const rawTrait = (score?.trait_reported ?? "").toString();
				const displayTraitRaw = rawTrait.length > 20 ? rawTrait.slice(0, 20) + "..." : rawTrait;
				const trait = escapeHtml(displayTraitRaw);
				const traitTitle = escapeHtml(rawTrait);
				const variants = escapeHtml(score?.variants_number ?? "");
				const date = escapeHtml(score?.date_release ?? "");
				const checked = selectedIds.has(rawPgsId) ? "checked" : "";

				return `
					<tr>
						<td>${startIndex + index + 1}</td>
						<td><input class="pgs-select" type="checkbox" value="${pgsId}" ${checked} /></td>
						<td>${pgsId}</td>
						<td title="${pgsNameTitle}">${pgsName}</td>
						<td title="${traitTitle}">${trait}</td>
						<td>${variants}</td>
						<td>${date}</td>
					</tr>
				`;
			})
			.join("");

		scoresDiv.innerHTML = `
			<div class="d-flex justify-content-between align-items-center my-2">
				<h5 class="mb-0">${escapeHtml(title)}</h5>
				<div>
					<label class="form-check-label me-2" for="selectAllPgs_${key}">Select all</label>
					<input class="form-check-input" id="selectAllPgs_${key}" type="checkbox" ${scores.length > 0 && selectedIds.size === scores.length ? "checked" : ""} />
				</div>
			</div>
			<div class="table-responsive">
				<table class="table table-sm table-striped table-bordered align-middle">
					<thead  class="table-dark">
						<tr>
							<th>#</th>
							<th>Select</th>
							<th>PGS ID</th>
							<th>Name</th>
							<th>Trait</th>
							<th>Variants #</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						${rowsHtml}
					</tbody>
				</table>
			</div>
			<div class="d-flex justify-content-between align-items-center mt-2">
				<div id="selectedPgsSummary_${key}" class="small text-muted">Selected: ${selectedIds.size} / ${MAX_SELECTION}</div>
				<div class="d-flex align-items-center gap-2">
					<button id="prevPage_${key}" class="btn btn-sm btn-outline-secondary" ${currentPage === 1 ? "disabled" : ""}>Previous</button>
					<span id="pageInfo_${key}" class="small text-muted">Page ${currentPage} of ${totalPages}</span>
					<button id="nextPage_${key}" class="btn btn-sm btn-outline-secondary" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
				</div>
			</div>
		`;

		const selectAll = document.getElementById(`selectAllPgs_${key}`);
		const rowCheckboxes = Array.from(scoresDiv.querySelectorAll(".pgs-select"));
		const prevPageBtn = document.getElementById(`prevPage_${key}`);
		const nextPageBtn = document.getElementById(`nextPage_${key}`);

		if (selectAll) {
			selectAll.addEventListener("change", () => {
				if (selectAll.checked) {
					// Limit to first MAX_SELECTION items
					scores.slice(0, MAX_SELECTION).forEach((score) => {
						const id = (score?.id ?? "").toString();
						selectedIds.add(id);
						selectedScoresMap.set(id, score);
					});
					if (scores.length > MAX_SELECTION) {
						alert(`Selection limited to ${MAX_SELECTION} items.`);
					}
				} else {
					selectedIds.clear();
					selectedScoresMap.clear();
				}
				renderPage();
				updateGlobalSelectionCount();
				// Notify participants table of PGS selection change
				window.onPgsSelectionChange?.();
			});
		}

		rowCheckboxes.forEach((cb) => {
			const score = scores.find(s => (s?.id ?? "").toString() === cb.value);
			cb.addEventListener("change", () => {
				if (cb.checked) {
					if (selectedIds.size >= MAX_SELECTION) {
						cb.checked = false;
						alert(`Maximum ${MAX_SELECTION} selections allowed.`);
						return;
					}
					selectedIds.add(cb.value);
					if (score) selectedScoresMap.set(cb.value, score);
				} else {
					selectedIds.delete(cb.value);
					selectedScoresMap.delete(cb.value);
				}
				if (selectAll) {
					selectAll.checked = scores.length > 0 && selectedIds.size === Math.min(scores.length, MAX_SELECTION);
				}
				const selectedPgsSummary = document.getElementById(`selectedPgsSummary_${key}`);
				if (selectedPgsSummary) {
					selectedPgsSummary.textContent = `Selected: ${selectedIds.size} / ${MAX_SELECTION}`;
				}
				updateGlobalSelectionCount();
				// Notify participants table of PGS selection change
				window.onPgsSelectionChange?.();
			});
		});

		if (prevPageBtn) {
			prevPageBtn.addEventListener("click", () => {
				currentPage -= 1;
				renderPage();
			});
		}

		if (nextPageBtn) {
			nextPageBtn.addEventListener("click", () => {
				currentPage += 1;
				renderPage();
			});
		}
	};

	renderPage();
	updateGlobalSelectionCount();
}

/**
 * Sanitize an arbitrary string into a safe key suitable for IDs or storage.
 * Lowercases the string, replaces non-alphanumeric sequences with underscores,
 * and trims leading/trailing underscores.
 * @param {any} value - The value to sanitize.
 * @returns {string} Sanitized key string.
 */
function sanitizeKey(value) {
	return String(value ?? "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "_")
		.replaceAll(/^_+|_+$/g, "");
}


/**
 * Render the table for a specific trait or category.
 * If `value` equals ALL_VALUE, all scores for that type are shown.
 * @param {string} value - Trait/category name or special value for all.
 * @param {"Trait"|"Category"} [type="Trait"] - Whether rendering traits or categories.
 */
function renderScores(value, type = "Trait") {
	const isCategory = type === "Category";
	const map = isCategory ? categoryScoresMap : traitScoresMap;
	const getFiltered = isCategory ? getFilteredCategoryScores : getFilteredTraitScores;

	//console.log(`Rendering ${type}: ${value}`);
	const isAll = value === ALL_VALUE;

	// Use filtered getter for "all", otherwise filter individual entry
	const scores = isAll
		? getFiltered()
		: (map.get(value) ?? []).filter(passesVariantFilter).sort(compareScores);

	const key = isAll ? `all_${type}s` : (sanitizeKey(value) || type);
	//console.log(key,`Found ${scores.length} scores for ${type} "${value}" after filtering by variant count`, scores);
	const typeLabel = type === "Category" ? "categories" : "traits";
	const title = isAll
		? `All Scoring files (${scores.length} entries across ${map.size} ${typeLabel})`
		: `${type}: ${value} (${scores.length} scoring files)`;

	renderPgsTable(scores, "scoresDiv", title, key);
}


/**
 * Global handler wired to the trait select control.
 * Validates the selection and triggers rendering for the chosen trait.
 * @param {string} selectedTrait - Value of the selected trait option.
 */
window.onPgsTraitChange = function onPgsTraitChange(selectedTrait) {
	if (!selectedTrait) return;

	// Special: show all scoring files
	if (selectedTrait === ALL_VALUE) {
		renderScores(ALL_VALUE, "Trait");
		return;
	}

	// If a trait name was selected, render that trait
	if (traitScoresMap.has(selectedTrait)) {
		renderScores(selectedTrait, "Trait");
		return;
	}

	// Otherwise assume the selection is a PGS id and render that single file
	const pgsId = selectedTrait;
	const match = getFilteredTraitScores().find((s) => String(s?.id ?? "") === String(pgsId));
	if (!match) return;
	const title = `${match.id} - ${match.name ?? match.trait_reported ?? "PGS"}`;
	renderPgsTable([match], "scoresDiv", title, sanitizeKey(pgsId));
};


// --- Helpers for dropdown management ---

/** Default onchange handler for trait selection. */
function setDefaultTraitOnChange(select) {
	select.onchange = (e) => {
		try { window.onPgsTraitChange(e.target.value); } catch (err) { console.error('onPgsTraitChange error', err); }
	};
}

/** Build options HTML from a Map of name → scores[]. */
function buildOptionsHtml(map, keys, allLabel, filteredCount) {
	const allOption = `<option value="${ALL_VALUE}"> ${filteredCount} scoring files for all ${map.size} ${allLabel}</option>`;
	const itemOptions = keys
		.map((key) => {
			const filtered = (map.get(key) ?? []).filter(passesVariantFilter);
			return `<option value="${escapeHtml(key)}">${escapeHtml(key)} (${filtered.length})</option>`;
		})
		.join("");
	return allOption + itemOptions;
}

/** Populate dropdown with traits and wire default handler. */
function populateTraitDropdown(select) {
	select.innerHTML = buildOptionsHtml(traitScoresMap, traits, "traits", getFilteredTraitScores().length);
	select.value = ALL_VALUE;
	renderScores(ALL_VALUE, "Trait");
	setDefaultTraitOnChange(select);
}

/** Populate dropdown with categories and wire category handler. */
function populateCategoryDropdown(select) {
	select.innerHTML = buildOptionsHtml(categoryScoresMap, categories, "categories", getFilteredCategoryScores().length);
	select.value = ALL_VALUE;
	renderScores(ALL_VALUE, "Category");

	select.onchange = (e) => {
		const val = e.target.value;
		if (!val) return;
		if (val === ALL_VALUE) {
			setDefaultTraitOnChange(select);
			renderScores(ALL_VALUE, "Category");
			return;
		}
		renderScores(val, "Category");
	};
}

// --- Initialize dropdown and wire buttons ---

const pgsSelect = document.getElementById("pgsDropDown");

if (pgsSelect) {
	if (!traits.length) {
		pgsSelect.innerHTML = `<option value="">No traits found (${variantMin}-${variantMax} variants)</option>`;
	} else {
		populateTraitDropdown(pgsSelect);
	}
}

const traitBtn = document.getElementById("traitBtn");
const categoryBtn = document.getElementById("categoryBtn");

/** Set the active button styling (blue) and reset the other. */
function setActiveButton(activeBtn) {
	[traitBtn, categoryBtn].forEach((btn) => {
		if (!btn) return;
		if (btn === activeBtn) {
			btn.classList.remove("btn-outline-primary");
			btn.classList.add("btn-primary");
		} else {
			btn.classList.remove("btn-primary");
			btn.classList.add("btn-outline-primary");
		}
	});
}

if (traitBtn && pgsSelect) {
	setActiveButton(traitBtn); // default active on load
	traitBtn.addEventListener("click", () => {
		console.log("Load Traits button clicked");
		try {
			populateTraitDropdown(pgsSelect);
			setActiveButton(traitBtn);
		} catch (err) { console.error('traitBtn click error', err); }
	});
}

if (categoryBtn && pgsSelect) {
	categoryBtn.addEventListener("click", () => {
		console.log("Load Categories button clicked");
		try {
			populateCategoryDropdown(pgsSelect);
			setActiveButton(categoryBtn);
		} catch (err) { console.error('categoryBtn click error', err); }
	});
}

// --- Variant range slider ---

const variantMinSlider = document.getElementById("variantMinSlider");
const variantMaxSlider = document.getElementById("variantMaxSlider");
const variantRangeLabel = document.getElementById("variantRangeLabel");
const variantMinInput = document.getElementById("variantMinInput");
const variantMaxInput = document.getElementById("variantMaxInput");
const variantProgressBar = document.getElementById("variantProgressBar");

/** Track current mode to know which dropdown to refresh on slider change. */
let currentMode = "Trait";

/** Update the slider UI labels and progress bar. */
function updateSliderLabels() {
	if (variantRangeLabel) variantRangeLabel.textContent = `${variantMin} - ${variantMax}`;
	if (variantMinInput) variantMinInput.value = variantMin;
	if (variantMaxInput) variantMaxInput.value = variantMax;
	if (variantMinSlider) variantMinSlider.value = variantMin;
	if (variantMaxSlider) variantMaxSlider.value = variantMax;
	// Update progress bar position
	if (variantProgressBar) {
		const minPercent = ((variantMin - 1) / 999) * 100;
		const maxPercent = ((variantMax - 1) / 999) * 100;
		variantProgressBar.style.left = minPercent + "%";
		variantProgressBar.style.right = (100 - maxPercent) + "%";
	}
}

/** Refresh the current view after slider change. */
function refreshCurrentView() {
	if (!pgsSelect) return;
	const currentValue = pgsSelect.value; // Preserve current selection
	if (currentMode === "Category") {
		// Rebuild dropdown but preserve selection
		pgsSelect.innerHTML = buildOptionsHtml(categoryScoresMap, categories, "categories", getFilteredCategoryScores().length);
		// Restore selection if it still exists
		if (currentValue && Array.from(pgsSelect.options).some(opt => opt.value === currentValue)) {
			pgsSelect.value = currentValue;
		} else {
			pgsSelect.value = ALL_VALUE;
		}
		renderScores(pgsSelect.value, "Category");
	} else {
		// Rebuild dropdown but preserve selection
		pgsSelect.innerHTML = buildOptionsHtml(traitScoresMap, traits, "traits", getFilteredTraitScores().length);
		// Restore selection if it still exists
		if (currentValue && Array.from(pgsSelect.options).some(opt => opt.value === currentValue)) {
			pgsSelect.value = currentValue;
		} else {
			pgsSelect.value = ALL_VALUE;
		}
		renderScores(pgsSelect.value, "Trait");
	}
	setDefaultTraitOnChange(pgsSelect);
}

/** Debounce timer for slider input. */
let sliderDebounce = null;

/** Debounced refresh to avoid too many updates while dragging. */
function debouncedRefresh() {
	clearTimeout(sliderDebounce);
	sliderDebounce = setTimeout(refreshCurrentView, 150);
}

if (variantMinSlider) {
	variantMinSlider.addEventListener("input", () => {
		variantMin = Math.min(parseInt(variantMinSlider.value, 10), variantMax - 1);
		updateSliderLabels();
		debouncedRefresh();
	});
}

if (variantMaxSlider) {
	variantMaxSlider.addEventListener("input", () => {
		variantMax = Math.max(parseInt(variantMaxSlider.value, 10), variantMin + 1);
		updateSliderLabels();
		debouncedRefresh();
	});
}

// Number input event listeners
if (variantMinInput) {
	variantMinInput.addEventListener("input", () => {
		let val = parseInt(variantMinInput.value, 10) || 1;
		val = Math.max(1, Math.min(val, variantMax - 1));
		variantMin = val;
		updateSliderLabels();
		debouncedRefresh();
	});
}

if (variantMaxInput) {
	variantMaxInput.addEventListener("input", () => {
		let val = parseInt(variantMaxInput.value, 10) || 1000;
		val = Math.max(variantMin + 1, Math.min(val, 1000));
		variantMax = val;
		updateSliderLabels();
		debouncedRefresh();
	});
}

// Initialize progress bar on load
updateSliderLabels();

// Update mode tracking when buttons are clicked
if (traitBtn) {
	traitBtn.addEventListener("click", () => { currentMode = "Trait"; });
}
if (categoryBtn) {
	categoryBtn.addEventListener("click", () => { currentMode = "Category"; });
}

// --- Fetch and parse PGS scoring files (text files with variants) ---

// Store loaded PGS text files globally for PRS calculation
window.loadedPgsTxts = [];

/**
 * Fetch and parse selected PGS scoring files.
 * The parsed files are stored in window.loadedPgsTxts for use by calculatePRS.
 */
async function fetchScoresTxts() {
	const statusEl = document.getElementById("fetchScoresStatus");
	const txtsDiv = document.getElementById("scoreTxtsDiv");
	
	try {
		const selectedIds = window.getSelectedPgsIds?.() ?? [];
		const selectedScores = window.getSelectedScores?.() ?? [];
		
		if (selectedIds.length === 0) {
			if (statusEl) statusEl.textContent = "Please select at least one scoring file from the table.";
			return;
		}
		
		if (statusEl) statusEl.textContent = `Fetching ${selectedIds.length} PGS file(s)...`;
		if (txtsDiv) txtsDiv.style.display = "block";
		
		// Fetch PGS text files using the SDK
		//console.log(`Fetching ${selectedIds.length} PGS files:`, selectedIds);
		const pgsTxts = await getPgsTxt(selectedIds);
		
		window.loadedPgsTxts = pgsTxts;
		console.log(`\n=== Results saved to window.loadedPgsTxts ===`);


		if (statusEl) statusEl.textContent = `Loaded ${pgsTxts.length} of ${selectedIds.length} PGS file(s).`;

		const nextToPrsBtn = document.getElementById('nextToPrsBtn');
		if (nextToPrsBtn) nextToPrsBtn.style.display = '';
		
		// Ensure the v4/v5 SNP sets are ready before computing overlap percentages
		if (window._v4v5OverlapReady) await window._v4v5OverlapReady;
		
		// Compare loaded PGS files with 23andMe SNPs (v4, v5, both)
		const pgsMatchStats = compareSnpOverlap(pgsTxts);
		
		// Show summary of loaded files with match percentages
		renderLoadedPgsTable(txtsDiv, pgsTxts, selectedScores, pgsMatchStats);
		
		// Also update the Calculate PRS tab's "1.) Select Weight Files" section
		updatePrsScoresDisplay(pgsTxts, selectedScores);
		
		console.log("Loaded PGS files:", pgsTxts);
		
	} catch (err) {
		console.error("fetchScoresTxts error:", err);
		if (statusEl) statusEl.textContent = `Error: ${err.message}`;
	}
}

// Current filter settings for PGS match percentage
let pgsMatchFilter = { type: 'both', metric: 'weight', minPercent: 0 };

/**
 * Render loaded PGS table with match percentages and filter controls.
 */
function renderLoadedPgsTable(txtsDiv, pgsTxts, selectedScores, pgsMatchStats) {
	if (!txtsDiv) return;
	
	// Filter PGS files based on current filter settings
	const filteredPgs = pgsTxts.filter(pgs => {
		const pgsId = pgs?.id ?? pgs?.meta?.pgs_id ?? "";
		const stats = pgsMatchStats[pgsId];
		if (!stats) return true;
		
		let matchPercent;
		const useWeight = pgsMatchFilter.metric === 'weight';
		
		if (pgsMatchFilter.type === 'v4') {
			matchPercent = useWeight ? stats.v4WeightPercent : stats.v4Percent;
		} else if (pgsMatchFilter.type === 'v5') {
			matchPercent = useWeight ? stats.v5WeightPercent : stats.v5Percent;
		} else {
			matchPercent = useWeight ? stats.bothWeightPercent : stats.bothPercent;
		}
		
		return matchPercent >= pgsMatchFilter.minPercent;
	});
	
	const rows = filteredPgs.map((pgs, idx) => {
		const id = escapeHtml(pgs?.id ?? pgs?.meta?.pgs_id ?? "");
		const variantCount = pgs?.dt?.length ?? 0;
		const score = selectedScores.find(s => s.id === pgs.id);
		const trait = escapeHtml(score?.trait_reported ?? "");
		const stats = pgsMatchStats[id] ?? {};
		
		return `
			<tr>
				<td>${idx + 1}</td>
				<td>${id}</td>
				<td title="${escapeHtml(score?.trait_reported ?? '')}">${trait.length > 20 ? trait.slice(0,20) + '...' : trait}</td>
				<td>${variantCount.toLocaleString()}</td>
				<td>${stats.v4Percent?.toFixed(1) ?? '-'}%</td>
				<td>${stats.v5Percent?.toFixed(1) ?? '-'}%</td>
				<td>${stats.bothPercent?.toFixed(1) ?? '-'}%</td>
				<td>${stats.v4WeightPercent?.toFixed(1) ?? '-'}%</td>
				<td>${stats.v5WeightPercent?.toFixed(1) ?? '-'}%</td>
				<td>${stats.bothWeightPercent?.toFixed(1) ?? '-'}%</td>
			</tr>`;
	}).join("");
	
	txtsDiv.innerHTML = `
		<h6 class="mt-3">Loaded PGS Scoring Files</h6>
		<div class="mb-2 d-flex flex-wrap align-items-center gap-2">
			<label class="form-label mb-0 small"><b>Filter by:</b></label>
			<select id="pgsMatchMetricFilter" class="form-select form-select-sm" style="width: auto;">
				<option value="weight" ${pgsMatchFilter.metric === 'weight' ? 'selected' : ''}>Effect Weight %</option>
				<option value="snp" ${pgsMatchFilter.metric === 'snp' ? 'selected' : ''}>SNP Count %</option>
			</select>
			<select id="pgsMatchTypeFilter" class="form-select form-select-sm" style="width: auto;">
				<option value="both" ${pgsMatchFilter.type === 'both' ? 'selected' : ''}>Both (v4 ∩ v5)</option>
				<option value="v4" ${pgsMatchFilter.type === 'v4' ? 'selected' : ''}>v4 only</option>
				<option value="v5" ${pgsMatchFilter.type === 'v5' ? 'selected' : ''}>v5 only</option>
			</select>
			<label class="form-label mb-0 small">Min %:</label>
			<input type="number" id="pgsMatchMinPercent" class="form-control form-control-sm" style="width: 80px;" 
				   value="${pgsMatchFilter.minPercent}" min="0" max="100" step="5" />
			<button id="applyPgsMatchFilter" class="btn btn-sm btn-primary">Apply</button>
			<span class="small text-muted">(${filteredPgs.length} of ${pgsTxts.length} shown)</span>
		</div>
		<div class="table-responsive">
			<table class="table table-sm table-striped">
				<thead class="table-dark">
					<tr>
						<th rowspan="2">#</th>
						<th rowspan="2">PGS ID</th>
						<th rowspan="2">Trait</th>
						<th rowspan="2">Variants</th>
						<th colspan="3" class="text-center">SNP Count %</th>
						<th colspan="3" class="text-center">Effect Weight %</th>
					</tr>
					<tr>
						<th>v4_chip</th>
						<th>v5_chip</th>
						<th>Both</th>
						<th>v4_chip</th>
						<th>v5_chip</th>
						<th>Both</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
		<p class="small text-muted">Files ready for PRS calculation. Go to Calculate PRS tab and click "Calculate PRS".</p>`;
	
	// Wire up filter controls
	const metricSelect = document.getElementById('pgsMatchMetricFilter');
	const typeSelect = document.getElementById('pgsMatchTypeFilter');
	const minInput = document.getElementById('pgsMatchMinPercent');
	const applyBtn = document.getElementById('applyPgsMatchFilter');
	
	if (applyBtn) {
		applyBtn.addEventListener('click', () => {
			pgsMatchFilter.metric = metricSelect?.value ?? 'weight';
			pgsMatchFilter.type = typeSelect?.value ?? 'both';
			pgsMatchFilter.minPercent = parseFloat(minInput?.value ?? 0);
			renderLoadedPgsTable(txtsDiv, pgsTxts, selectedScores, pgsMatchStats);
		});
	}
}

/**
 * Compare loaded PGS files with 23andMe SNPs (v4, v5, and overlap).
 * Returns match statistics for each PGS file including effect weight percentages.
 * @param {Array} pgsTxts - Loaded PGS text files
 * @returns {Object} Map of pgsId -> { v4Percent, v5Percent, bothPercent, v4WeightPercent, v5WeightPercent, bothWeightPercent, ... }
 */
function compareSnpOverlap(pgsTxts) {
	console.log("compareSnpOverlap called with", pgsTxts?.length, "PGS files");
	
	const v4Array = window.v4_23andme ?? [];
	const v5Array = window.v5_23andme ?? [];
	const bothArray = window.v4_v5_23andme ?? [];
	
	const v4Set = new Set(v4Array);
	const v5Set = new Set(v5Array);
	const bothSet = new Set(bothArray);
	
	console.log(`23andMe SNP sets: v4=${v4Set.size}, v5=${v5Set.size}, both=${bothSet.size}`);
	
	if (v4Set.size === 0 && v5Set.size === 0) {
		console.warn("23andMe SNP sets not computed yet. Run computeV4V5Overlap() first.");
		return {};
	}
	
	// Store results globally
	window.pgsOverlapResults = {};
	const stats = {};
	
	//console.log(`\n=== PGS vs 23andMe SNP Match Analysis ===`);
	
	for (const pgs of pgsTxts) {
		const pgsId = pgs?.id ?? pgs?.meta?.pgs_id ?? "unknown";
		const cols = pgs?.cols ?? [];
		const dt = pgs?.dt ?? [];
		
		// Find column indices
		const hmChrIdx = cols.indexOf('hm_chr');
		const hmPosIdx = cols.indexOf('hm_pos');
		const effectWeightIdx = cols.indexOf('effect_weight');
		
		if (hmChrIdx < 0 || hmPosIdx < 0) {
			console.warn(`${pgsId}: Missing hm_chr or hm_pos columns.`);
			stats[pgsId] = { 
				v4Percent: 0, v5Percent: 0, bothPercent: 0, 
				v4WeightPercent: 0, v5WeightPercent: 0, bothWeightPercent: 0,
				v4Rows: [], v5Rows: [], bothRows: [] 
			};
			continue;
		}
		
		// Calculate total effect weight (use absolute values)
		let totalWeight = 0;
		let v4Weight = 0;
		let v5Weight = 0;
		let bothWeight = 0;
		
		// Find matching rows for each set
		const v4Rows = [];
		const v5Rows = [];
		const bothRows = [];
		
		for (const row of dt) {
			const chr = row[hmChrIdx];
			const pos = row[hmPosIdx];
			const key = `${chr}:${pos}`;
			const weight = effectWeightIdx >= 0 ? Math.abs(parseFloat(row[effectWeightIdx]) || 0) : 0;
			
			totalWeight += weight;
			
			// Build row object with column names
			const rowObj = {};
			cols.forEach((col, i) => {
				rowObj[col] = row[i];
			});
			rowObj._chrPosKey = key;
			rowObj._absWeight = weight;
			
			if (v4Set.has(key)) {
				v4Rows.push(rowObj);
				v4Weight += weight;
			}
			if (v5Set.has(key)) {
				v5Rows.push(rowObj);
				v5Weight += weight;
			}
			if (bothSet.has(key)) {
				bothRows.push(rowObj);
				bothWeight += weight;
			}
		}
		
		const totalVariants = dt.length;
		
		// SNP count percentages
		const v4Percent = totalVariants > 0 ? (v4Rows.length / totalVariants) * 100 : 0;
		const v5Percent = totalVariants > 0 ? (v5Rows.length / totalVariants) * 100 : 0;
		const bothPercent = totalVariants > 0 ? (bothRows.length / totalVariants) * 100 : 0;
		
		// Effect weight percentages
		const v4WeightPercent = totalWeight > 0 ? (v4Weight / totalWeight) * 100 : 0;
		const v5WeightPercent = totalWeight > 0 ? (v5Weight / totalWeight) * 100 : 0;
		const bothWeightPercent = totalWeight > 0 ? (bothWeight / totalWeight) * 100 : 0;
		
		stats[pgsId] = { 
			v4Percent, v5Percent, bothPercent, 
			v4WeightPercent, v5WeightPercent, bothWeightPercent,
			v4Rows, v5Rows, bothRows, 
			totalVariants, totalWeight,
			v4Weight, v5Weight, bothWeight
		};
		
		// Store in global results (keep bothRows for backward compatibility)
		window.pgsOverlapResults[pgsId] = bothRows;
		
		//console.log(`${pgsId}: ${totalVariants} variants | SNP%: v4=${v4Percent.toFixed(1)}%, v5=${v5Percent.toFixed(1)}%, both=${bothPercent.toFixed(1)}% | Weight%: v4=${v4WeightPercent.toFixed(1)}%, v5=${v5WeightPercent.toFixed(1)}%, both=${bothWeightPercent.toFixed(1)}%`);
	}
	
	// Store full stats globally
	window.pgsMatchStats = stats;
	
	console.log(`\n=== Results saved to window.pgsMatchStats ===`);
	return stats;
}

window.compareSnpOverlap = compareSnpOverlap;

/**
 * Update the Calculate PRS tab's weight files display.
 * @param {Array} pgsTxts - Loaded PGS text files
 * @param {Array} selectedScores - Selected score metadata
 */
function updatePrsScoresDisplay(pgsTxts, selectedScores) {
	const prsScoresDiv = document.getElementById("prsScoresDiv");
	const prsScoresAction = document.getElementById("prsScoresAction");
	
	if (prsScoresDiv) {
		prsScoresDiv.textContent = `Loaded ${pgsTxts.length} scoring file(s) from Polygenic Scores tab.`;
	}
	
	if (prsScoresAction && pgsTxts.length > 0) {
		const rows = pgsTxts.map((pgs, idx) => {
			const id = escapeHtml(pgs?.id ?? pgs?.meta?.pgs_id ?? "");
			const variantCount = pgs?.dt?.length ?? 0;
			const score = selectedScores?.find(s => s.id === pgs.id) ?? {};
			const name = escapeHtml(score?.name ?? "");
			const trait = escapeHtml(score?.trait_reported ?? "");
			const date = escapeHtml(score?.date_release ?? "");
			return `
				<tr>
					<td>${idx + 1}</td>
					<td><input type="checkbox" class="form-check-input prs-select-cb" value="${id}" checked /></td>
					<td>${id}</td>
					<td>${name}</td>
					<td>${trait}</td>
					<td>${variantCount.toLocaleString()}</td>
					<td>${date}</td>
				</tr>`;
		}).join("");
		
		prsScoresAction.innerHTML = `
			<table class="table table-striped table-sm mt-3">
				<thead class="table-dark">
					<tr>
						<th>#</th>
						<th>Select</th>
						<th>PGS ID</th>
						<th>Name</th>
						<th>Trait</th>
						<th>Variants</th>
						<th>Date</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>`;
	}
}

window.updatePrsScoresDisplay = updatePrsScoresDisplay;
window.fetchScoresTxts = fetchScoresTxts;

// Wire up the Fetch Files button in the Polygenic Scores tab
const fetchScoresBtn = document.getElementById("fetchScoresBtn");
if (fetchScoresBtn) {
	fetchScoresBtn.addEventListener("click", fetchScoresTxts);
}

const fetchPgsFilesBtn = document.getElementById("fetchPgsFilesBtn");
if (fetchPgsFilesBtn) {
	fetchPgsFilesBtn.addEventListener("click", fetchScoresTxts);
}

// --- Direct PGS ID entry ---

/**
 * Parse a free-text string of PGS IDs into a validated array of uppercase IDs.
 * Accepts comma, space, semicolon, or newline as delimiters.
 * Returns only strings matching the PGS + digits pattern.
 */
function parsePgsIdInput(raw) {
	return raw
		.split(/[\s,;]+/)
		.map(s => s.trim().toUpperCase())
		.filter(s => /^PGS\d+$/.test(s));
}

/**
 * Add PGS IDs typed directly into the text input to the current selection.
 * Looks up metadata from already-loaded catalog data first; falls back to
 * fetching from the PGS Catalog REST API for unknown IDs.
 */
async function addPgsByDirectInput() {
	const inputEl = document.getElementById("directPgsInput");
	const statusEl = document.getElementById("directPgsStatus");

	if (!inputEl) return;

	const ids = parsePgsIdInput(inputEl.value);
	if (ids.length === 0) {
		if (statusEl) statusEl.textContent = "No valid PGS IDs found. Use format: PGS000001";
		return;
	}

	// Enforce global selection cap
	const remaining = MAX_SELECTION - selectedPgsIds.size;
	if (remaining <= 0) {
		if (statusEl) statusEl.textContent = `Selection is already at the maximum of ${MAX_SELECTION}. Deselect some entries first.`;
		return;
	}
	const idsToAdd = ids.slice(0, remaining);
	if (ids.length > remaining) {
		if (statusEl) statusEl.textContent = `Only ${remaining} slot(s) remaining — adding first ${remaining} of ${ids.length} IDs.`;
	}

	if (statusEl) statusEl.textContent = `Looking up ${idsToAdd.length} ID(s)...`;

	// Build a lookup from already-loaded catalog entries
	const catalogLookup = new Map(
		[...allTraitScores, ...allCategoryScores].map(s => [s?.id ?? "", s])
	);

	const toFetch = [];
	for (const id of idsToAdd) {
		if (selectedPgsIds.has(id)) continue; // already selected
		const known = catalogLookup.get(id);
		if (known) {
			selectedPgsIds.add(id);
			selectedScoresMap.set(id, known);
		} else {
			toFetch.push(id);
		}
	}

	// Fetch metadata for IDs not in local cache
	if (toFetch.length > 0) {
		if (statusEl) statusEl.textContent = `Fetching metadata for ${toFetch.length} unknown ID(s)...`;
		try {
			const result = await fetchSomeScores(toFetch);
			const fetched = result?.scores ?? [];
			const fetchedMap = new Map(fetched.map(s => [s?.id ?? "", s]));
			for (const id of toFetch) {
				const score = fetchedMap.get(id) ?? { id }; // stub if not found
				selectedPgsIds.add(id);
				selectedScoresMap.set(id, score);
			}
		} catch (err) {
			console.error("addPgsByDirectInput: fetchSomeScores error", err);
			// Add stubs so the IDs are still selectable
			for (const id of toFetch) {
				selectedPgsIds.add(id);
				selectedScoresMap.set(id, { id });
			}
		}
	}

	updateGlobalSelectionCount();
	window.onPgsSelectionChange?.();

	const addedCount = idsToAdd.filter(id => selectedPgsIds.has(id)).length;
	if (statusEl) {
		statusEl.textContent = `Added ${addedCount} ID(s). Total selected: ${selectedPgsIds.size} / ${MAX_SELECTION}.`;
		statusEl.classList.remove("text-danger");
		statusEl.classList.add("text-success");
		setTimeout(() => {
			statusEl.classList.remove("text-success");
			statusEl.classList.add("text-muted");
		}, 3000);
	}
	inputEl.value = "";
}

const addPgsByIdBtn = document.getElementById("addPgsByIdBtn");
if (addPgsByIdBtn) {
	addPgsByIdBtn.addEventListener("click", addPgsByDirectInput);
}

// Also allow pressing Enter in the textarea to trigger the add
const directPgsInput = document.getElementById("directPgsInput");
if (directPgsInput) {
	directPgsInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			addPgsByDirectInput();
		}
	});
}

// --- window.sdk namespace (scores/catalog) ---
window.sdk = Object.assign(window.sdk ?? {}, {
	// PGS selection
	getSelectedPgsIds: () => Array.from(selectedPgsIds),
	getSelectedScores: () => Array.from(selectedScoresMap.values()),
	clearSelectedScores: window.clearSelectedScores,

	// Catalog UI
	onPgsTraitChange: window.onPgsTraitChange,
	compareSnpOverlap,
	fetchScoresTxts,
	updatePrsScoresDisplay,
});
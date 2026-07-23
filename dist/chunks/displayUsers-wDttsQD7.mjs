import { allUsersMetaDataByType_fast, get23Txt } from 'https://lorenasandoval88.github.io/personal_genomes_project_sdk/dist/sdk.mjs';
import { l as localforage } from '../app.mjs';
import 'https://lorenasandoval88.github.io/pgs_catalog_sdk/dist/sdk.mjs';
import 'https://lorenasandoval88.github.io/clustjs/dist/sdk.mjs';
import 'https://esm.run/@mlc-ai/web-llm';

// console.log("displayUsers.js loaded")

/**
 * Extract a human-readable full name from a genome filename.
 * e.g. "PGP_hu09B28E_genome_Joshua_Yoakem_v5_Full_...txt" → "Joshua Yoakem"
 */
function nameFromFilename(filename) {
	if (!filename) return null;
	const base = String(filename).replace(/.*\//, '');
	const m = base.match(/(?:^|_)genome_(.+?)_[vV]\d+_/i);
	if (!m) return null;
	return m[1]
		.replace(/_/g, ' ')
		.replace(/\b\w/g, c => c.toUpperCase())
		.trim() || null;
}

// Update loading progress indicator
const participantsProgressBar = document.getElementById('participantsProgressBar');
function setParticipantsLoadingProgress(progress) {
	if (participantsProgressBar) {
		participantsProgressBar.style.width = `${progress}%`;
	}
}

// Show initial loading state
setParticipantsLoadingProgress(20);

setParticipantsLoadingProgress(50);
// Default to 'all' mode — fast fetch with no per-profile round trips
const data = await allUsersMetaDataByType_fast();
setParticipantsLoadingProgress(100);

let participants = data ?? [];
let allParticipantsFast = participants; // already loaded
let curatedJsonParticipants = null; // cached JSON dataset

const ROWS_PER_PAGE = 50;
const MAX_SELECTION = 10;

// Module-level selected users (shared across renders)
const selectedUserIds = new Set();
const selectedUsersMap = new Map(); // Map<id, userObject>

/** Get the currently selected user IDs. */
window.getSelectedUserIds = () => Array.from(selectedUserIds);

/** Get the currently selected users with full metadata. */
window.getSelectedUsers = () => Array.from(selectedUsersMap.values());

/** Clear only PGP participant selections (leaves uploaded files intact). */
window.clearPGPSelections = function () {
	for (const [id, user] of selectedUsersMap) {
		if (user.dataSource !== "file Upload") {
			selectedUsersMap.delete(id);
			selectedUserIds.delete(id);
		}
	}
	// Uncheck all PGP checkboxes in the participant table
	document.querySelectorAll('#localUsersDiv input[type="checkbox"]').forEach(cb => cb.checked = false);
	updateGlobalSelectionCount();
};

/** Clear only uploaded local file selections (leaves PGP participants intact). */
window.clearUploadedFiles = function () {
	for (const [id, user] of selectedUsersMap) {
		if (user.dataSource === "file Upload") {
			selectedUsersMap.delete(id);
			selectedUserIds.delete(id);
		}
	}
	const statusEl = document.getElementById("my23Status");
	if (statusEl) statusEl.textContent = "";
	updateGlobalSelectionCount();
};


/** Update the global selection count display. */
function updateGlobalSelectionCount() {
	// Update count on 23andMe Data tab
	const el = document.getElementById("globalSelectionCount2");
	if (el) el.textContent = `Selected Data: ${selectedUserIds.size} / ${MAX_SELECTION}`;

	// Update loaded count: uploaded files are already parsed, show them immediately
	const loadedCount = document.getElementById("loadedFilesCount");
	if (loadedCount) {
		const alreadyLoaded = Array.from(selectedUsersMap.values()).filter(u => u._parsed && u._parsed.dt && u._parsed.dt.length > 0);
		if (alreadyLoaded.length > 0) {
			loadedCount.textContent = `Loaded Data: ${alreadyLoaded.length} / ${selectedUserIds.size}`;
			loadedCount.style.display = '';
		} else {
			loadedCount.style.display = 'none';
		}
	}

	// Show/hide Fetch button based on whether any users are selected
	const fetchBtn = document.getElementById("fetchUsersBtn");
	if (fetchBtn) {
		fetchBtn.style.display = selectedUserIds.size > 0 ? '' : 'none';
		// Reset to red whenever selection changes (new upload or PGP selection)
		fetchBtn.classList.remove('btn-secondary');
		fetchBtn.classList.add('btn-danger');
	}


	// Show/hide unselect buttons based on what is selected
	const hasUploaded = Array.from(selectedUsersMap.values()).some(u => u.dataSource === 'file Upload');
	const hasPGP = Array.from(selectedUsersMap.values()).some(u => u.dataSource !== 'file Upload');
	const clearUploadedBtn = document.getElementById('clearUploadedBtn');
	const clearPGPBtn = document.getElementById('clearPGPBtn');
	if (clearUploadedBtn) clearUploadedBtn.style.display = hasUploaded ? '' : 'none';
	if (clearPGPBtn) clearPGPBtn.style.display = hasPGP ? '' : 'none';

	// Also update PRS tab user section to reflect selection
	const prsUsersdiv = document.getElementById("prsUsersdiv");
	if (prsUsersdiv && selectedUserIds.size > 0) {
		const userList = Array.from(selectedUsersMap.values())
			.map(u => u.name || u.id)
			.join(", ");
		prsUsersdiv.textContent = `${selectedUserIds.size} user(s) selected: ${userList}`;
	}
	
	// console.log(`Selection updated: ${selectedUserIds.size} user(s)`, Array.from(selectedUserIds));
}
/**
 * escapeHtml(value)
 * Escape HTML special characters to prevent injection when inserting text into the DOM.
 * @param {any} value
 * @returns {string}
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
 * formatGenotypes(genotypes)
 * Format an array of genotype/file objects into an HTML string for display.
 * @param {Array} genotypes
 * @returns {string}
 */
// function formatGenotypes(genotypes) {
// 	console.log("Formatting genotypes:", genotypes);
// 	if (!Array.isArray(genotypes) || !genotypes.length) return "-";
// 	return genotypes
// 		.map((g) => {
// 			const name = g.filename ?? g.file ?? g.download_url ?? g.filetype ?? "(file)";
// 			const type = g.filetype ?? "";
// 			return `${escapeHtml(name)} ${type ? `(${escapeHtml(type)})` : ""}`;
// 		})
// 		.join("<br>");
// }

/**
 * sanitizeKey(value)
 * Produce a lowercase alphanumeric underscore-only key suitable for element IDs.
 * @param {string} value
 * @returns {string}
 */
function sanitizeKey(value) {
	return String(value)
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "_")
		.replaceAll(/^_+|_+$/g, "");
}

/**
 * extractVersion(item)
 * Extract the 23andMe chip version (e.g., "v4", "v5") from genotype filenames.
 * @param {Object} item - Participant object with genotypes array
 * @returns {string|null} Version string like "v4", "v5", or null if not found
 */
function extractVersion(item) {
	const filename = item.fileName ?? item.name ?? '';
	// console.log("Extracting version from filename:", filename,item);
	// Match patterns like _v4_, _v5_, v4_Full, v5_Full, etc.
	const match = String(filename).match(/_v(\d+)_|v(\d+)_Full/i);
	if (match) {
		const version = match[1] ?? match[2];
		// console.log("Found version:", version);
		return `v${version}`;
	}
	return null;
}

/**
 * Populate the `participantsVersionSelect` dropdown with available 23andMe chip versions.
 * @returns {void}
 */
function populateVersionSelect() {
	const sel = document.getElementById('participantsVersionSelect');
	if (!sel) return;
	const counts = new Map();
	participants.forEach((p) => {
		const v = extractVersion(p);
		const key = v ?? 'Unknown';
		counts.set(key, (counts.get(key) || 0) + 1);
	});
	// Sort versions numerically (v3, v4, v5, etc.)
	const versions = Array.from(counts.keys()).filter(k => k !== 'Unknown').sort((a, b) => {
		const numA = parseInt(a.replace('v', ''));
		const numB = parseInt(b.replace('v', ''));
		return numA - numB;
	});
	const opts = [`<option value="">All Versions (${participants.length})</option>`].concat(versions.map(v => `<option value="${v}">${v} (${counts.get(v)})</option>`));
	if (counts.has('Unknown')) opts.push(`<option value="Unknown">Unknown (${counts.get('Unknown')})</option>`);
	sel.innerHTML = opts.join('');
}
window.populateVersionSelect = populateVersionSelect;

/**
 * Apply version filter to participants and re-render the table.
 * @returns {void}
 */
function applyParticipantFilters() {
	const versionSel = document.getElementById('participantsVersionSelect');
	const version = versionSel?.value ?? '';

	let list = participants;

	if (version && version !== '') {
		list = list.filter(p => (extractVersion(p) ?? 'Unknown') === version);
	}

	const key = sanitizeKey('participants') || 'participants';
	const filterLabel = version && version !== '' ? version : 'All';
	renderParticipantsTable(list, 'localUsersDiv', `Personal Genome Project Participants (${list.length}) - ${filterLabel}`, key);
}
window.applyParticipantFilters = applyParticipantFilters;

/**
 * Handler invoked when the version dropdown changes; filters participants and re-renders the table.
 * @param {string} selectedVersion
 * @returns {void}
 */
window.onParticipantsVersionChange = function onParticipantsVersionChange(selectedVersion) {
	const sel = document.getElementById('participantsVersionSelect');
	if (sel && selectedVersion !== undefined) sel.value = selectedVersion;
	applyParticipantFilters();
};

/**
 * Handler invoked when the load-mode toggle changes ('all' vs 'json').
 * @param {'all'|'json'} mode
 */
window.onParticipantsModeChange = async function onParticipantsModeChange(mode) {
	if (mode === 'json') {
		if (!curatedJsonParticipants) {
			showParticipantsLoadingOverlay(true, 20, 'Loading curated JSON list...');
			try {
				const res = await fetch('data/PGP_participants.json');
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				curatedJsonParticipants = await res.json();
			} catch (err) {
				console.error('Failed to load curated JSON:', err);
				curatedJsonParticipants = [];
				alert(`Failed to load data/PGP_participants.json: ${err.message}`);
			} finally {
				showParticipantsLoadingOverlay(false);
			}
		}
		participants = curatedJsonParticipants ?? [];
	} else {
		if (!allParticipantsFast) {
			showParticipantsLoadingOverlay(true, 20, 'Fetching all participants...');
			try {
				allParticipantsFast = await allUsersMetaDataByType_fast();
			} catch (err) {
				console.error('allUsersMetaDataByType_fast error:', err);
				allParticipantsFast = [];
			} finally {
				showParticipantsLoadingOverlay(false);
			}
		}
		participants = allParticipantsFast ?? [];
	}

	populateVersionSelect();
	applyParticipantFilters();
};

/**
 * Callback invoked when PGS score selection changes.
 * Re-renders the participants table to reflect the new selection.
 * @returns {void}
 */
window.onPgsSelectionChange = function onPgsSelectionChange() {
	// console.log('PGS selection changed, re-rendering participants table');
	applyParticipantFilters();
};

/**
 * Show a loading overlay in the participants table container.
 * @param {boolean} show - Whether to show or hide the overlay
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Loading message to display
 */
function showParticipantsLoadingOverlay(show, progress = 0, message = 'Loading...') {
	const container = document.getElementById('localUsersDiv');
	if (!container) return;
	
	let overlay = document.getElementById('participantsLoadingOverlay');
	
	if (show) {
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = 'participantsLoadingOverlay';
			overlay.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(255,255,255,0.9); display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 100;';
			overlay.innerHTML = `
				<div class="spinner-border text-primary mb-3" role="status">
					<span class="visually-hidden">Loading...</span>
				</div>
				<div class="progress w-50 mb-2" style="height: 6px;">
					<div id="loadMoreProgressBar" class="progress-bar progress-bar-striped progress-bar-animated" style="width: 0%"></div>
				</div>
				<small id="loadMoreMessage" class="text-muted">Loading...</small>
			`;
			container.style.position = 'relative';
			container.appendChild(overlay);
		}
		const progressBar = document.getElementById('loadMoreProgressBar');
		const messageEl = document.getElementById('loadMoreMessage');
		if (progressBar) progressBar.style.width = `${progress}%`;
		if (messageEl) messageEl.textContent = message;
	} else {
		if (overlay) overlay.remove();
	}
}

/**
 * Render a paginated participants table with selection and pagination controls.
 * @param {Array<Object>} list - Array of participant objects to display.
 * @param {string} targetId - DOM element ID to render the table into.
 * @param {string} title - Title text to display above the table.
 * @param {string} key - Unique key used to construct control IDs.
 * @returns {void}
 */
function renderParticipantsTable(list, targetId, title, key) {
	const container = document.getElementById(targetId);
	if (!container) return;
	container.style.display = 'block';

	let currentPage = 1;
	const selectedIds = selectedUserIds; // Use module-level set

	const renderPage = () => {
		const totalPages = Math.max(1, Math.ceil(list.length / ROWS_PER_PAGE));
		currentPage = Math.min(Math.max(1, currentPage), totalPages);
		const startIndex = (currentPage - 1) * ROWS_PER_PAGE;
		const pageItems = list.slice(startIndex, startIndex + ROWS_PER_PAGE);

		const rowsHtml = pageItems.map((p, i) => {
			const rawId = p.id ?? p.participant_id ?? p.name ?? `user_${startIndex + i + 1}`;
			const pid = escapeHtml(String(rawId));
			const genoFilename =
				p.fileName ??
				p.finalUrl ??
				p.genotypes?.[0]?.filename ??
				p.genotypes?.[0]?.download_url ??
				p.downloadUrl ??
				p.download_url;
			//console.log('[displayUsers] participant fields:', p.id, { fileName: p.fileName, finalUrl: p.finalUrl, downloadUrl: p.downloadUrl, geno0: p.genotypes?.[0] });
			const rawName = nameFromFilename(genoFilename) || String(p.name ?? "");
			// Enrich the participant object so selectedUsersMap stores the full name
			p.name = rawName || p.name;
			const name = escapeHtml(rawName);
			const displayName = escapeHtml(rawName.length > 14 ? rawName.slice(0, 14) + '...' : rawName);
			// const genos = p.genotypes ?? [];
			// const genoCount = genos.length;
			// const genoList = formatGenotypes(genos);

			/**
			 * getPublishedDate(item)
			 * Return a published/date string from an item using common property names.
			 * @param {Object} item
			 * @returns {string}
			 */
			function getPublishedDate(item) {
				return item.publishedDate ?? item.published_date ?? item.date ?? item.created ?? "-";
			}

			/**
			 * getDownloadUrl(item)
			 * Prefer known download URL fields (downloadUrl, download_url, url, profileUrl).
			 * @param {Object} item
			 * @returns {string|null}
			 */
			function getDownloadUrl(item) {
				return item.downloadUrl ?? item.download_url ?? item.url ?? item.profileUrl ?? null;
			}

			const published = escapeHtml(String(getPublishedDate(p)));

			/**
			 * getProfileUrl(item)
			 * Extract a profile URL from common candidate properties.
			 * @param {Object} item
			 * @returns {string|null}
			 */
			function getProfileUrl(item) {
				return item.profileUrl ?? item.profile_url ?? null;
			}

			const profileUrl = getProfileUrl(p);
			const profileHtml = profileUrl ? `<a href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener">View</a>` : "-";

			const downloadUrl = getDownloadUrl(p);
			const downloadHtml = downloadUrl ? `<a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener">${escapeHtml(downloadUrl)}</a>` : "-";
			const checked = selectedIds.has(String(rawId)) ? 'checked' : '';
			const version = extractVersion(p) ?? '-';

			// Curated-JSON extras
			const filename = p.filename ?? p.fileName ?? p.innerFilename ?? p.genotypes?.[0]?.filename ?? '';
			const filenameHtml = filename ? escapeHtml(filename) : '-';
			const build = p.genomeBuild ?? p.build ?? '-';
			const sizeMB = p.genomeBuildFiles?.[0]?.sizeMB ?? p.sizeMB ?? null;
			const sizeHtml = (sizeMB != null) ? `${Number(sizeMB).toFixed(2)}` : '-';

			return `
				<tr>
					<td>${startIndex + i + 1}</td>
					<td><input class="participant-select" type="checkbox" value="${escapeHtml(String(rawId))}" ${checked} /></td>
					<td>${pid}</td>
					<td title="${name}">${displayName}</td>
					<td>${version}</td>
					<td>${escapeHtml(String(build))}</td>
					<td>${sizeHtml}</td>
					<td title="${escapeHtml(filename)}">${filenameHtml}</td>
					<td>${published}</td>
					<td>${profileHtml}</td>
					<td>${downloadHtml}</td>
				</tr>
			`;
		}).join('');

		// Clear fallback users table now that real participants are rendered
		const fallbackTable = document.getElementById('prsUsersAction');
		if (fallbackTable) fallbackTable.innerHTML = '';

		container.innerHTML = `
			<div class="d-flex justify-content-between align-items-center my-2">
				<h5 class="mb-0">${escapeHtml(title)}</h5>
				<div class="d-flex align-items-center gap-2">
					<label class="form-check-label me-2" for="selectAllParticipants_${key}">Select all</label>
					<input class="form-check-input" id="selectAllParticipants_${key}" type="checkbox" ${list.length > 0 && selectedIds.size === list.length ? 'checked' : ''} />
					<button id="deselectAllParticipants_${key}" class="btn btn-outline-secondary btn-sm" style="font-size:0.7rem;padding:2px 6px;">Deselect all</button>
				</div>
			</div>
			<div class="table-responsive">
				<table class="table table-sm table-striped table-bordered align-middle">
					<thead class="table-dark">
						<tr>
							<th>#</th>
							<th>Select</th>
							<th>Participant ID</th>
							<th>Name</th>
							<th>Version</th>
							<th>Build</th>
							<th>Size (MB)</th>
							<th>Filename</th>
							<th>Published Date</th>
							<th>Profile</th>
							<th>Download URL</th>
						</tr>
					</thead>
					<tbody>
						${rowsHtml}
					</tbody>
				</table>
			</div>
			<div class="d-flex justify-content-between align-items-center mt-2">
			<div id="selectedParticipantsSummary_${key}" class="small text-muted">Selected: ${selectedIds.size} / ${MAX_SELECTION}</div>
				<div class="d-flex align-items-center gap-2">
					<button id="prevPage_${key}" class="btn btn-sm btn-outline-secondary" ${currentPage === 1 ? 'disabled' : ''}>Previous</button>
					<span id="pageInfo_${key}" class="small text-muted">Page ${currentPage} of ${totalPages}</span>
					<button id="nextPage_${key}" class="btn btn-sm btn-outline-secondary" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
				</div>
			</div>
		`;

		const selectAll = document.getElementById(`selectAllParticipants_${key}`);
		const deselectAllBtn = document.getElementById(`deselectAllParticipants_${key}`);
		const rowCheckboxes = Array.from(container.querySelectorAll('.participant-select'));
		const prevPageBtn = document.getElementById(`prevPage_${key}`);
		const nextPageBtn = document.getElementById(`nextPage_${key}`);

		if (deselectAllBtn) {
			deselectAllBtn.addEventListener('click', () => {
				selectedIds.clear();
				selectedUsersMap.clear();
				if (selectAll) selectAll.checked = false;
				renderPage();
				updateGlobalSelectionCount();
			});
		}

		if (selectAll) {
			selectAll.addEventListener('change', () => {
				if (selectAll.checked) {
					// Limit to first MAX_SELECTION items
					list.slice(0, MAX_SELECTION).forEach((it) => {
						const id = String(it.id ?? it.participant_id ?? it.name);
						selectedIds.add(id);
						selectedUsersMap.set(id, it);
					});
					if (list.length > MAX_SELECTION) {
						alert(`Selection limited to ${MAX_SELECTION} items.`);
					}
				} else {
					selectedIds.clear();
					selectedUsersMap.clear();
				}
				renderPage();
				updateGlobalSelectionCount();
			});
		}

		rowCheckboxes.forEach((cb) => {
			const user = list.find(it => String(it.id ?? it.participant_id ?? it.name) === cb.value);
			cb.addEventListener('change', () => {
				if (cb.checked) {
					if (selectedIds.size >= MAX_SELECTION) {
						cb.checked = false;
						alert(`Maximum ${MAX_SELECTION} selections allowed.`);
						return;
					}
					selectedIds.add(cb.value);
					if (user) selectedUsersMap.set(cb.value, user);
				} else {
					selectedIds.delete(cb.value);
					selectedUsersMap.delete(cb.value);
				}
				if (selectAll) selectAll.checked = list.length > 0 && selectedIds.size === Math.min(list.length, MAX_SELECTION);
				const summary = document.getElementById(`selectedParticipantsSummary_${key}`);
				if (summary) summary.textContent = `Selected: ${selectedIds.size} / ${MAX_SELECTION}`;
				updateGlobalSelectionCount();

			});
		});

		if (prevPageBtn) prevPageBtn.addEventListener('click', () => { currentPage -= 1; renderPage(); });
		if (nextPageBtn) nextPageBtn.addEventListener('click', () => { currentPage += 1; renderPage(); });
	};

	renderPage();
}

/**
 * renderLocalUsers()
 * Public entry point that renders the participants table (honoring any active year/version filters).
 */
window.renderLocalUsers = () => {
	applyParticipantFilters();
};

// If the GenomicData tab is already visible on load, render immediately
if (document.getElementById("GenomicData")?.style.display === "block") {
	window.renderLocalUsers();
}

// populate version select after definitions
populateVersionSelect();

// --- Upload Your 23andMe File Button Handler ---

/**
 * Handle user clicking the "Upload Your 23andMe File" button.
 * Opens a file picker and parses the selected file.
 */
const my23Btn = document.getElementById("my23Btn");
const my23FileInput = document.getElementById("my23FileInput");
const my23Status = document.getElementById("my23Status");

if (my23Btn && my23FileInput) {
	// console.log("Setting up 23andMe file upload handler");
	// Clicking the button triggers the hidden file input
	my23Btn.addEventListener("click", () => {
		// console.log("Upload 23andMe button clicked");
		my23FileInput.click();
	});

	// Handle file selection (up to 5 files)
	my23FileInput.addEventListener("change", async (event) => {
		const MAX_UPLOAD = 5;
		const files = Array.from(event.target.files ?? []).slice(0, MAX_UPLOAD);
		if (files.length === 0) return;

		if (my23Status) my23Status.textContent = `Reading ${files.length} file(s)...`;

		const messages = [];

		// Clear fallback users table now that real data is loaded
		const fallbackTable = document.getElementById('prsUsersAction');
		if (fallbackTable) fallbackTable.innerHTML = '';

		for (const file of files) {
			try {
				const text = await file.text();

				let parsed = await get23Txt(file);
				if (!parsed || !parsed.dt) {
					throw new Error("get23Txt did not return expected parsed data structure.");
				}
				parsed = {
					cols: parsed.cols || [],
					dt: parsed.dt || [],
					meta: parsed.meta || ""
				};

				if (!parsed.dt.length) {
					messages.push(`⚠ ${file.name}: failed to parse.`);
					continue;
				}

				// Extract published date from first line
				const firstLine = text.split(/[\r\n]/)[0] ?? "";
				let publishedDate = new Date().toISOString().slice(0, 10);
				const dateMatch = firstLine.match(/at:\s*(.+)$/i);
				if (dateMatch) {
					const parsedDate = new Date(dateMatch[1].trim());
					if (!isNaN(parsedDate.getTime())) {
						publishedDate = parsedDate.toISOString().slice(0, 10);
					}
				}

				const userId = file.name;
				const user = {
					id: userId,
					name: nameFromFilename(file.name) || file.name,
					fileName: file.name,
					dataSource: "file Upload",
					dataType: "23andMe",
					downloadUrl: null,
					profileUrl: null,
					publishedDate: publishedDate,
					_parsed: parsed,
				};

				// Cache parsed genome data using the same key pattern as calculatePrs.js
				try {
					await localforage.setItem(`Genome:23andMe-txt-${userId}`, parsed);
					console.log(`Cached uploaded genome for ${userId} (${parsed.dt.length} variants)`);
				} catch (cacheErr) {
					console.warn(`Failed to cache genome for ${userId}:`, cacheErr);
				}

				if (selectedUserIds.size < MAX_SELECTION) {
					selectedUserIds.add(userId);
					selectedUsersMap.set(userId, user);
					updateGlobalSelectionCount();
					messages.push(`✓ ${file.name}: ${parsed.dt.length.toLocaleString()} variants added.`);
				} else {
					messages.push(`⚠ ${file.name}: max selection (${MAX_SELECTION}) reached.`);
				}
			} catch (err) {
				console.error("Error reading 23andMe file:", err);
				messages.push(`✗ ${file.name}: ${err.message}`);
			}
		}

		if (my23Status) my23Status.innerHTML = messages.join('<br>');

		// Show fetch button if any files were successfully loaded
		const fetchBtn = document.getElementById('fetchUsersBtn');
		if (fetchBtn && selectedUserIds.size > 0) {
			fetchBtn.style.display = '';
		}

		// Reset input so the same file(s) can be re-selected
		my23FileInput.value = "";
	});
}

// --- Option D: Load by ID + Download URL ---
const loadByUrlBtn = document.getElementById("loadByUrlBtn");
const loadByUrlExampleBtn = document.getElementById("loadByUrlExampleBtn");
if (loadByUrlExampleBtn) {
	loadByUrlExampleBtn.addEventListener("click", () => {
		const idInput = document.getElementById("loadByUrlId");
		const urlInput = document.getElementById("loadByUrlDownload");
		if (idInput) idInput.value = "hu4B2FD9";
		if (urlInput) urlInput.value = "https://my.pgp-hms.org/user_file/download/3864";
	});
}
if (loadByUrlBtn) {
	loadByUrlBtn.addEventListener("click", async () => {
		const idInput = document.getElementById("loadByUrlId");
		const urlInput = document.getElementById("loadByUrlDownload");
		const statusEl = document.getElementById("loadByUrlStatus");
		const id = (idInput?.value ?? "").trim();
		const url = (urlInput?.value ?? "").trim();

		if (!id || !url) {
			if (statusEl) statusEl.textContent = "Both ID and Download URL are required.";
			return;
		}
		if (selectedUserIds.has(id)) {
			if (statusEl) statusEl.textContent = `ID "${id}" is already selected.`;
			return;
		}
		if (selectedUserIds.size >= MAX_SELECTION) {
			if (statusEl) statusEl.textContent = `Maximum ${MAX_SELECTION} selections reached.`;
			return;
		}

		if (statusEl) statusEl.textContent = `Loading ${id}...`;
		loadByUrlBtn.disabled = true;

		try {
			let parsed = await get23Txt(url, id, false);
			if (!parsed || !parsed.dt) {
				throw new Error("get23Txt did not return expected parsed data.");
			}
			parsed = {
				cols: parsed.cols || [],
				dt: parsed.dt || [],
				meta: parsed.meta || "",
			};

			try {
				await localforage.setItem(`Genome:23andMe-txt-${id}`, parsed);
			} catch (cacheErr) {
				console.warn(`Failed to cache genome for ${id}:`, cacheErr);
			}

			const user = {
				id,
				name: nameFromFilename(url) || id,
				fileName: String(url).split("/").pop() || id,
				dataSource: "url",
				dataType: "23andMe",
				downloadUrl: url,
				profileUrl: null,
				publishedDate: new Date().toISOString().slice(0, 10),
				_parsed: parsed,
			};

			selectedUserIds.add(id);
			selectedUsersMap.set(id, user);
			updateGlobalSelectionCount();

			if (statusEl) {
				statusEl.innerHTML = `\u2713 ${escapeHtml(id)}: ${parsed.dt.length.toLocaleString()} variants loaded and cached.`;
			}
			idInput.value = "";
			urlInput.value = "";
		} catch (err) {
			console.error("Load by URL failed:", err);
			if (statusEl) statusEl.textContent = `\u2717 ${err.message}`;
		} finally {
			loadByUrlBtn.disabled = false;
		}
	});
}

// --- Genome cache: show / clear ---
async function showGenomicCache() {
	const container = document.getElementById("genomicCacheList");
	if (!container) return;
	container.innerHTML = '<span class="small text-muted">Reading cache...</span>';
	try {
		const keys = await localforage.keys();
		const genomeKeys = keys.filter(k => k.startsWith("Genome:"));
		if (genomeKeys.length === 0) {
			container.innerHTML = '<span class="small text-muted"><em>No cached genomes.</em></span>';
			return;
		}
		let totalBytes = 0;
		const rows = [];
		for (const key of genomeKeys) {
			const item = await localforage.getItem(key);
			const bytes = new Blob([JSON.stringify(item ?? null)]).size;
			totalBytes += bytes;
			// SDK caches wrap payload under .data; local caching stores {cols, dt, meta} directly.
			const payload = item?.data ?? item;
			const variants = payload?.dt?.length ?? 0;
			rows.push(
				`<li><code>${escapeHtml(key)}</code> \u2014 ${variants.toLocaleString()} variants \u2014 ${(bytes / 1024 / 1024).toFixed(2)} MB</li>`
			);
		}
		container.innerHTML =
			`<div class="small text-muted mb-1"><b>Total:</b> ${genomeKeys.length} item(s), ${(totalBytes / 1024 / 1024).toFixed(2)} MB</div>` +
			`<ul class="small mb-0" style="max-height:220px;overflow:auto;">${rows.join("")}</ul>`;
	} catch (err) {
		console.error("showGenomicCache failed:", err);
		container.innerHTML = `<span class="small text-danger">Error reading cache: ${escapeHtml(err.message)}</span>`;
	}
}
window.showGenomicCache = showGenomicCache;

const showGenomicCacheBtn = document.getElementById("showGenomicCacheBtn");
if (showGenomicCacheBtn) {
	showGenomicCacheBtn.addEventListener("click", showGenomicCache);
}

const clearGenomicCacheBtn = document.getElementById("clearGenomicCacheBtn");
if (clearGenomicCacheBtn) {
	clearGenomicCacheBtn.addEventListener("click", async () => {
		try {
			const keys = await localforage.keys();
			const gKeys = keys.filter(k => k.startsWith("Genome:"));
			for (const k of gKeys) await localforage.removeItem(k);
			const container = document.getElementById("genomicCacheList");
			if (container) {
				container.innerHTML = `<span class="small text-muted">Cleared ${gKeys.length} genome cache item(s).</span>`;
			}
		} catch (err) {
			alert(`Error clearing genome cache: ${err.message}`);
		}
	});
}

// --- Compute overlapping SNPs between Joshua and Marika based on chr:position ---
/**
 * Build a set of chr:position keys from parsed 23andMe data.//113816
 * @param {Object} parsed - Parsed 23andMe data with cols and dt
 * @returns {Set<string>} Set of "chr:position" strings
 */
// function getChrPosSet(parsed) {
// 	const chrIdx = parsed.cols.indexOf('chromosome');
// 	const posIdx = parsed.cols.indexOf('position');
// 	const set = new Set();
// 	for (const row of parsed.dt) {
// 		const chr = row[chrIdx];
// 		const pos = row[posIdx];
// 		if (chr && pos != null) {
// 			set.add(`${chr}:${pos}`);
// 		}
// 	}
// 	return set;
// }
function getChrPosSet(parsed) {
  if (!parsed?.cols || !parsed?.dt) return new Set();

  const chrIdx = parsed.cols.indexOf('chromosome');
  const posIdx = parsed.cols.indexOf('position');

  if (chrIdx < 0 || posIdx < 0) {
    console.warn('Missing chromosome or position column', parsed.cols);
    return new Set();
  }

  const set = new Set();

  for (const row of parsed.dt) {
    const chr = row[chrIdx];
    const pos = row[posIdx];

    if (chr != null && pos != null && chr !== '' && pos !== '') {
      set.add(`${chr}:${pos}`);
    }
  }

  return set;
}




/**
 * Compute overlapping SNP positions between two 23andMe files.
 */
async function computeV4V5Overlap() {
  try {
    const joshuaUrl = 'data/PGP_hu09B28E_genome_Joshua_Yoakem_v5_Full_20250127054538.txt';
    const marikaUrl = 'data/PGP_huAE4518_genome_Marika_Forsythe_v4_Full_20240826181111.txt';

    const [joshuaParsed, marikaParsed] = await Promise.all([
      get23Txt(joshuaUrl),
      get23Txt(marikaUrl),
    ]);

    const joshuaSet = getChrPosSet(joshuaParsed);
    const marikaSet = getChrPosSet(marikaParsed);

    const overlap = [...joshuaSet].filter(key => marikaSet.has(key));

    // Store individual sets and overlap globally
    window.v5_23andme = [...joshuaSet];  // v5 SNPs (Joshua)
    window.v4_23andme = [...marikaSet];  // v4 SNPs (Marika)
    window.v4_v5_23andme = overlap;      // Overlap of both

	// console.log(`23andMe SNP sets computed:`);
	// console.log(`  v5 (Joshua): ${joshuaSet.size} SNPs`);
	// console.log(`  v4 (Marika): ${marikaSet.size} SNPs`);
	// console.log(`  Overlap: ${overlap.length} SNPs`);

    return overlap;
  } catch (err) {
    console.error('Error computing v4_v5_23andme overlap:', err);
    window.v5_23andme = [];
    window.v4_23andme = [];
    window.v4_v5_23andme = [];
    return [];
  }
}

// Initialize v4_v5_23andme on load — store the promise so fetchScoresTxts can await it
window._v4v5OverlapReady = computeV4V5Overlap();

// --- window.sdk namespace (users/participants) ---
window.sdk = Object.assign(window.sdk ?? {}, {
	// User selection
	getSelectedUserIds: () => Array.from(selectedUserIds),
	getSelectedUsers: () => Array.from(selectedUsersMap.values()),

	// Participant table UI
	renderLocalUsers: window.renderLocalUsers,
	applyParticipantFilters,
	populateVersionSelect,
	onParticipantsVersionChange: window.onParticipantsVersionChange,
	onParticipantsModeChange: window.onParticipantsModeChange,
	onPgsSelectionChange: window.onPgsSelectionChange,
});
//# sourceMappingURL=displayUsers-wDttsQD7.mjs.map

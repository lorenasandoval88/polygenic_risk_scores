import { allUsersMetaDataByType_fast, fetch23andMeParticipants, get23Txt } from 'https://lorenasandoval88.github.io/personal_genomes_project_sdk/dist/sdk.mjs';
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

const INITIAL_LIMIT = 5;
setParticipantsLoadingProgress(50);
// Default to 'all' mode — fast fetch with no per-profile round trips
const data = await allUsersMetaDataByType_fast();
setParticipantsLoadingProgress(100);

let participants = data ?? [];
let currentLimit = INITIAL_LIMIT;
let participantLoadMode = 'all'; // 'paged' | 'all'
let allParticipantsFast = participants; // already loaded

const ROWS_PER_PAGE = 50;
const MAX_SELECTION = 10;

// Module-level selected users (shared across renders)
const selectedUserIds = new Set();
const selectedUsersMap = new Map(); // Map<id, userObject>

/** Get the currently selected user IDs. */
window.getSelectedUserIds = () => Array.from(selectedUserIds);

/** Get the currently selected users with full metadata. */
window.getSelectedUsers = () => Array.from(selectedUsersMap.values());


/** Update the global selection count display. */
function updateGlobalSelectionCount() {
	// Update count on 23andMe Data tab
	const el = document.getElementById("globalSelectionCount2");
	if (el) el.textContent = `Selected: ${selectedUserIds.size} / ${MAX_SELECTION}`;

	// Show/hide Fetch button based on whether any users are selected
	const fetchBtn = document.getElementById("fetchUsersBtn");
	if (fetchBtn) fetchBtn.style.display = selectedUserIds.size > 0 ? '' : 'none';
	
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

	// Hide/show Load More button based on mode
	const loadMoreBtn = document.getElementById('loadMore_participants');
	if (loadMoreBtn) loadMoreBtn.style.display = participantLoadMode === 'all' ? 'none' : '';
	
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
 * Handler invoked when the load-mode toggle changes (paged vs all).
 * In 'all' mode, fetches all participants at once via allUsersMetaDataByType_fast.
 * @param {string} mode - 'paged' or 'all'
 */
window.onParticipantsModeChange = async function onParticipantsModeChange(mode) {
	participantLoadMode = mode;

	// Update button styles
	const pagedBtn = document.getElementById('modePagedBtn');
	const allBtn = document.getElementById('modeAllBtn');
	if (pagedBtn) pagedBtn.classList.toggle('btn-primary', mode === 'paged');
	if (pagedBtn) pagedBtn.classList.toggle('btn-outline-primary', mode !== 'paged');
	if (allBtn) allBtn.classList.toggle('btn-primary', mode === 'all');
	if (allBtn) allBtn.classList.toggle('btn-outline-primary', mode !== 'all');

	if (mode === 'all') {
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
	} else {
		// Revert to the initial paged data
		const paged = await fetch23andMeParticipants(currentLimit);
		participants = paged ?? [];
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
 * Load more participants by fetching additional rows.
 * @param {number} count - Number of additional participants to load (default: 5)
 * @returns {Promise<void>}
 */
async function loadMoreParticipants(count = 5) {
	const newLimit = currentLimit + count;
	
	// console.log(`Loading more participants: ${currentLimit} -> ${newLimit}`);
	showParticipantsLoadingOverlay(true, 10, `Loading ${count} more participants...`);
	
	try {
		showParticipantsLoadingOverlay(true, 30, 'Fetching participant data...');
		const newData = await fetch23andMeParticipants(newLimit);
		showParticipantsLoadingOverlay(true, 70, 'Processing data...');
		
		// console.log(`Fetched ${newData?.length ?? 0} participants (requested ${newLimit})`);
		if (newData && newData.length > participants.length) {
			participants = newData;
			currentLimit = newLimit;
			showParticipantsLoadingOverlay(true, 90, 'Updating table...');
			populateVersionSelect();
			applyParticipantFilters();
			// console.log(`Loaded ${newData.length} participants total`);
		} else if (newData && newData.length === participants.length && newData.length < newLimit) {
			// All available participants already loaded
			// console.log('All available participants already loaded');
			alert(`All ${participants.length} available participants are already loaded.`);
		} else {
			// console.log('No additional participants available');
			alert('No additional participants available.');
		}
	} catch (err) {
		console.error('Error loading more participants:', err);
		alert('Failed to load more participants.');
	} finally {
		showParticipantsLoadingOverlay(false);
	}
}
window.loadMoreParticipants = loadMoreParticipants;

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

			return `
				<tr>
					<td>${startIndex + i + 1}</td>
					<td><input class="participant-select" type="checkbox" value="${escapeHtml(String(rawId))}" ${checked} /></td>
					<td>${pid}</td>
					<td title="${name}">${displayName}</td>
					<td>${version}</td>
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
				<div>
					<label class="form-check-label me-2" for="selectAllParticipants_${key}">Select all</label>
					<input class="form-check-input" id="selectAllParticipants_${key}" type="checkbox" ${list.length > 0 && selectedIds.size === list.length ? 'checked' : ''} />
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
					<button id="loadMore_${key}" class="btn btn-sm btn-outline-primary">Load 5 more</button>
					<button id="prevPage_${key}" class="btn btn-sm btn-outline-secondary" ${currentPage === 1 ? 'disabled' : ''}>Previous</button>
					<span id="pageInfo_${key}" class="small text-muted">Page ${currentPage} of ${totalPages}</span>
					<button id="nextPage_${key}" class="btn btn-sm btn-outline-secondary" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
				</div>
			</div>
		`;

		const selectAll = document.getElementById(`selectAllParticipants_${key}`);
		const rowCheckboxes = Array.from(container.querySelectorAll('.participant-select'));
		const prevPageBtn = document.getElementById(`prevPage_${key}`);
		const nextPageBtn = document.getElementById(`nextPage_${key}`);
		const loadMoreBtn = document.getElementById(`loadMore_${key}`);

		if (loadMoreBtn) {
			loadMoreBtn.style.display = participantLoadMode === 'all' ? 'none' : '';
			loadMoreBtn.addEventListener('click', async () => {
				loadMoreBtn.disabled = true;
				loadMoreBtn.textContent = 'Loading...';
				try {
					await loadMoreParticipants(5);
				} finally {
					loadMoreBtn.disabled = false;
					loadMoreBtn.textContent = 'Load 5 more';
				}
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

				// Use parse23Txt from the SDK if available, otherwise fall back to local parser
				let parsed;

				if (typeof get23Txt === "function") {
					parsed = await get23Txt(file);
					if (parsed && parsed.dt) {
						parsed = {
							cols: parsed.cols || [],
							dt: parsed.dt || [],
							meta: parsed.meta || ""
						};
					} else {
						throw new Error("get23Txt did not return expected parsed data structure.");
					}
				} else if (typeof window.parse23Txt === "function") {
					parsed = await window.parse23Txt(text);
				} else {
					parsed = parseLocalFile(text, file.name);
				}

				if (!parsed || !parsed.dt || parsed.dt.length === 0) {
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

		// Reset input so the same file(s) can be re-selected
		my23FileInput.value = "";
	});
}

/**
 * Fallback parser for 23andMe files when SDK parse23Txt is not available.
 * Matches the structure of parse23Txt from the SDK.
 * @param {string} txt - Raw file content
 * @param {string} url - Name or URL of the file
 * @returns {Object} Parsed data with cols, dt, meta arrays
 */
function parseLocalFile(txt, url) {
	const obj = {};
	const rows = String(txt ?? "").split(/[\r\n]+/g).filter(Boolean);
	obj.txt = txt;
	obj.url = url || "no url";

	const n = rows.filter(r => r && r[0] === '#').length;
	if (n === 0) {
		throw new Error(`Invalid 23andMe file format: missing header in ${url}`);
	}

	obj.meta = rows.slice(0, n - 1).join('\r\n');
	obj.cols = rows[n - 1].replace(/^#\s*/, '').split(/\t/);
	obj.dt = rows.slice(n).map((r, i) => {
		const parts = r.split('\t');
		parts[2] = parseInt(parts[2]); // position as integer
		parts[4] = i; // row index
		return parts;
	});
	return obj;
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

    const [joshuaRes, marikaRes] = await Promise.all([
      fetch(joshuaUrl),
      fetch(marikaUrl)
    ]);

    if (!joshuaRes.ok || !marikaRes.ok) {
      throw new Error(`Fetch failed: Joshua=${joshuaRes.status}, Marika=${marikaRes.status}`);
    }

    const [joshuaTxt, marikaTxt] = await Promise.all([
      joshuaRes.text(),
      marikaRes.text()
    ]);

    const joshuaParsed = parseLocalFile(joshuaTxt, joshuaUrl);
    const marikaParsed = parseLocalFile(marikaTxt, marikaUrl);

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

// Initialize v4_v5_23andme on load
computeV4V5Overlap();
//# sourceMappingURL=displayUsers-DdazXxiR.mjs.map

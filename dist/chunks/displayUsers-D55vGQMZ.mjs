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

/**
 * Truncate a URL for compact display: keep scheme + host prefix and the last path
 * segment, e.g. "https://my.pgp-hms.org/user_file/download/4215" -> "https:// ... /4215".
 */
function truncateUrlForDisplay(url) {
	if (!url) return '';
	try {
		const u = new URL(url);
		const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
		return `${u.protocol}// ... /${last}`;
	} catch {
		const s = String(url);
		const last = s.split('/').filter(Boolean).pop() || s;
		return `https:// ... /${last}`;
	}
}

/**
 * Extract age, gender, race, and ethnicity from a PGP profile's Google survey results.
 * `google_survey_results` is an array of surveys; each survey is an array of
 * [question, answer] pairs. We scan all pairs across all surveys.
 * Age is taken from "What is your age (in years)?" or computed from "Year of birth".
 * Race/ethnicity fallbacks use the combined "Race/ethnicity" field only when the
 * dedicated questions are missing. Grandparent race/ethnicity questions are ignored.
 */
function extractDemographics(profile) {
	const out = { age: null, gender: null, race: null, ethnicity: null };
	const surveys = profile?.google_survey_results;
	if (!Array.isArray(surveys)) return out;

	let birthYear = null;
	let raceEthnicityCombined = null;
	const currentYear = new Date().getFullYear();

	for (const survey of surveys) {
		if (!Array.isArray(survey)) continue;
		for (const pair of survey) {
			if (!Array.isArray(pair) || pair.length < 2) continue;
			const q = String(pair[0] ?? '').toLowerCase();
			const a = pair[1];
			if (a == null || a === '') continue;

			// Skip grandparent race/ethnicity questions (self only)
			const isGrandparent = q.includes('grandmother') || q.includes('grandfather');

			if (out.age == null && q.includes('what is your age')) {
				const n = parseInt(String(a), 10);
				if (Number.isFinite(n)) out.age = n;
			} else if (birthYear == null && q.includes('year of birth')) {
				const n = parseInt(String(a), 10);
				if (Number.isFinite(n) && n > 1900 && n <= currentYear) birthYear = n;
			}

			if (out.gender == null) {
				if (q === 'what is your gender?' || q.includes('sex/gender') || q.includes('anatomical sex at birth')) {
					if (!isGrandparent) out.gender = String(a).trim();
				}
			}

			if (out.race == null && !isGrandparent && q.includes('what is your race')) {
				out.race = String(a).trim();
			}
			if (out.ethnicity == null && !isGrandparent && q === 'what is your ethnicity?') {
				out.ethnicity = String(a).trim();
			}
			if (raceEthnicityCombined == null && !isGrandparent && q === 'race/ethnicity') {
				raceEthnicityCombined = String(a).trim();
			}
		}
	}

	if (out.age == null && birthYear != null) {
		out.age = currentYear - birthYear;
	}
	// Fall back to the combined field if the dedicated ones were absent
	if (out.race == null && raceEthnicityCombined) out.race = raceEthnicityCombined;
	if (out.ethnicity == null && raceEthnicityCombined) out.ethnicity = raceEthnicityCombined;
	return out;
}

/**
 * Map a single raw race token to a clean canonical category.
 * Returns null for non-informative answers (no response / prefer not to answer).
 */
function normalizeRaceToken(token) {
	const l = String(token ?? '').trim().toLowerCase();
	if (!l) return null;
	if (l.includes('american indian') || l.includes('alaska native')) return 'American Indian / Alaska Native';
	if (l.includes('african american') || l.includes('black')) return 'Black or African American';
	if (l.includes('native hawaiian') || l.includes('pacific islander')) return 'Native Hawaiian or Other Pacific Islander';
	if (l.includes('hispanic') || l.includes('latino')) return 'Hispanic or Latino';
	if (l.includes('caucasian') || l === 'white' || l.startsWith('white')) return 'White';
	if (l.includes('asian')) return 'Asian';
	if (l.includes('prefer not') || l === 'no response' || l === 'unknown' || l === 'n/a') return null;
	return 'Other';
}

/**
 * Normalize a raw race answer (often a comma-joined multi-select or free text)
 * into an array of clean, de-duplicated canonical categories.
 * @param {string|null} raw
 * @returns {string[]}
 */
function normalizeRaceCategories(raw) {
	if (raw == null || raw === '') return ['Unknown'];
	const set = new Set();
	for (const tok of String(raw).split(/[,;/]|\band\b/i)) {
		const cat = normalizeRaceToken(tok);
		if (cat) set.add(cat);
	}
	return set.size ? Array.from(set) : ['Unknown'];
}

/**
 * Normalize a raw ethnicity answer into a single clean canonical category.
 * @param {string|null} raw
 * @returns {string[]}
 */
function normalizeEthnicityCategories(raw) {
	if (raw == null || raw === '') return ['Unknown'];
	const l = String(raw).toLowerCase();
	if (l.includes('not hispanic')) return ['Not Hispanic or Latino'];
	if (l.includes('hispanic') || l.includes('latino') || l.includes('spanish')) return ['Hispanic or Latino'];
	if (l.includes('prefer not') || l === 'no response' || l === 'unknown' || l === 'n/a') return ['Unknown'];
	return ['Other'];
}

/**
 * Flatten a curated participant record from `pgp_participants_1017_with_profiles.json`
 * into the shape expected by the rest of this module. The new schema nests file-level
 * fields under `files[]`; the old code reads them at the top level.
 * We pick a primary file (prefer the first valid 23andMe file) and copy its fields up.
 * We also derive `age`, `gender`, and `valid23File` (any file is valid).
 */
function flattenCuratedRecord(rec) {
	if (!rec || typeof rec !== 'object') return rec;
	const files = Array.isArray(rec.files) ? rec.files : [];
	const primary = files.find(f => f?.valid23File) ?? files[0] ?? {};
	const anyValid23 = files.some(f => f?.valid23File === true);
	const { age, gender, race, ethnicity } = extractDemographics(rec.profile);
	return {
		id: rec.id,
		profileUrl: rec.profileUrl ?? null,
		number_of_files: rec.number_of_files ?? files.length,
		files,
		// Flattened primary-file fields (used by table/CSV/sort code)
		publishedDate: primary.publishedDate ?? null,
		dataType: primary.dataType ?? null,
		name: primary.name ?? null,
		downloadUrl: primary.downloadUrl ?? null,
		finalUrl: primary.finalUrl ?? null,
		filename: primary.filename ?? null,
		innerFilename: primary.innerFilename ?? null,
		genomeBuild: primary.genomeBuild ?? null,
		genomeBuildFiles: primary.genomeBuildFiles ?? [],
		gcsfilename: primary.genomeBuildFiles?.[0]?.gcsfilename ?? null,
		// Derived fields
		valid23File: anyValid23,
		age,
		gender,
		race,
		ethnicity,
		raceCategories: normalizeRaceCategories(race),
		ethnicityCategories: normalizeEthnicityCategories(ethnicity),
		// Preserve original profile for downstream use if needed
		profile: rec.profile ?? null,
	};
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
// Default to 'json' mode — curated pre-validated list (fast, includes filename/build/size)
let curatedJsonParticipants = null;
try {
	const res = await fetch('data/pgp_participants_1017_with_profiles.json');
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const raw = await res.json();
	curatedJsonParticipants = Array.isArray(raw) ? raw.map(flattenCuratedRecord) : [];
} catch (err) {
	console.error('Failed to load curated JSON:', err);
	curatedJsonParticipants = [];
}
setParticipantsLoadingProgress(100);

let participants = curatedJsonParticipants ?? [];
let allParticipantsFast = null; // fetched lazily when user switches to 'all' mode
let allParticipantsFetchedAt = null; // ISO date string of last successful fetch
const ALL_PARTICIPANTS_CACHE_KEY = 'PGP:AllParticipantsFast';
let participantLoadMode = 'json'; // 'all' | 'json' — sorting is only enabled in 'json' mode
let sortState = { key: null, dir: 'asc' }; // key: 'version' | 'build' | 'size' | null

// Restore any prior cached "All Participants" fetch from localforage
try {
	const cached = await localforage.getItem(ALL_PARTICIPANTS_CACHE_KEY);
	if (cached && Array.isArray(cached.data)) {
		allParticipantsFast = cached.data;
		allParticipantsFetchedAt = cached.fetchedAt ?? null;
	}
} catch (err) {
	console.warn('Failed to read cached All Participants:', err);
}

/** Format an ISO date string as a short human-readable local date/time. */
function formatFetchedAt(iso) {
	if (!iso) return '';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return '';
	return d.toLocaleString();
}

/** Update the "cached since <date>" info line under the Fetch All Participants button. */
function updateAllParticipantsCacheInfoUI() {
	const wrap = document.getElementById('allParticipantsCacheInfo');
	const dateEl = document.getElementById('allParticipantsCacheDate');
	if (!wrap || !dateEl) return;
	const showLine = participantLoadMode === 'all' && !!allParticipantsFetchedAt;
	if (showLine) {
		dateEl.textContent = `Cached: ${formatFetchedAt(allParticipantsFetchedAt)}${allParticipantsFast ? ` (${allParticipantsFast.length})` : ''}`;
		wrap.style.display = '';
	} else {
		wrap.style.display = 'none';
	}
}
updateAllParticipantsCacheInfoUI();

// Reflect count on the curated JSON button now that it's loaded
{
	const jsonBtn = document.getElementById('modeJsonBtn');
	if (jsonBtn) jsonBtn.textContent = `From Curated List`;
}

const ROWS_PER_PAGE = 200;
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


/**
 * Disable unchecked participant checkboxes once the selection limit is reached,
 * so clicks are visibly blocked (with an explanatory tooltip) rather than silently ignored.
 */
function updateSelectionAvailability() {
	const atLimit = selectedUserIds.size >= MAX_SELECTION;
	document.querySelectorAll('#localUsersDiv .participant-select').forEach((cb) => {
		if (cb.checked) {
			cb.disabled = false;
			cb.title = '';
		} else {
			cb.disabled = atLimit;
			cb.title = atLimit ? `Limit of ${MAX_SELECTION} reached — deselect one to add another.` : '';
		}
	});
}

/** Update the global selection count display. */
function updateGlobalSelectionCount() {
	const count = selectedUserIds.size;
	const atLimit = count >= MAX_SELECTION;

	// Prominent sticky bar: label + filled progress indicator
	const el = document.getElementById("globalSelectionCount2");
	if (el) el.textContent = `${count} of ${MAX_SELECTION} selected`;
	const bar = document.getElementById("selectionProgressBar");
	if (bar) {
		const pct = Math.min(100, Math.round((count / MAX_SELECTION) * 100));
		bar.style.width = `${pct}%`;
		bar.setAttribute('aria-valuenow', String(count));
		bar.classList.toggle('bg-success', !atLimit);
		bar.classList.toggle('bg-danger', atLimit);
	}
	const limitMsg = document.getElementById("selectionLimitMsg");
	if (limitMsg) limitMsg.style.display = atLimit ? '' : 'none';

	// Block further selection when the limit is reached
	updateSelectionAvailability();

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
		const users = Array.from(selectedUsersMap.values());
		const nameCounts = new Map();
		users.forEach(u => {
			const n = u.name || u.id;
			nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
		});
		const userList = users
			.map(u => {
				const n = u.name || u.id;
				return nameCounts.get(n) > 1 ? `${n} (${u.id})` : n;
			})
			.join(", ");
		prsUsersdiv.textContent = `${selectedUserIds.size} user(s) selected: ${userList}`;
	}

	// Mirror the fallback-users table for the current selection in the PRS tab
	renderSelectedUsersTable();

	// console.log(`Selection updated: ${selectedUserIds.size} user(s)`, Array.from(selectedUserIds));
}

/**
 * Render the current selection into #prsUsersAction using the same columns/style
 * as loadFallbackUsers / fetchUsers, so users see a table in the PRS tab immediately
 * after uploading or selecting participants (without having to click Load Fallback Users).
 */
function renderSelectedUsersTable() {
	const container = document.getElementById('prsUsersAction');
	if (!container) return;
	const selectedUsers = Array.from(selectedUsersMap.values());
	if (selectedUsers.length === 0) {
		container.innerHTML = '';
		return;
	}
	const rows = selectedUsers.map((user, idx) => {
		const id = escapeHtml(user?.id ?? user?.participant_id ?? "");
		const name = escapeHtml(user?.name ?? "");
		const published = escapeHtml(user?.publishedDate ?? user?.published_date ?? user?.date ?? "");
		const genos = user?.genotypes ?? [];
		const genoCount = genos.length || (user?.downloadUrl || user?.finalUrl || user?.fileName ? 1 : 0);
		const downloadUrl =
			user?.downloadUrl ?? user?.download_url ?? user?.finalUrl ??
			(genos[0]?.download_url ?? genos[0]?.file) ?? "";
		const downloadHtml = downloadUrl
			? `<a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener">Download</a>`
			: "-";
		const variantCount = user?._parsed?.dt?.length ?? 0;
		return `
			<tr>
				<td>${idx + 1}</td>
				<td><input type="checkbox" class="form-check-input prs-user-select-cb" value="${id}" checked /></td>
				<td>${id}</td>
				<td>${name}</td>
				<td>${published}</td>
				<td>${genoCount}</td>
				<td>${variantCount.toLocaleString()}</td>
				<td>${downloadHtml}</td>
			</tr>`;
	}).join("");
	container.innerHTML = `
		<table class="table table-striped table-sm mt-3">
			<thead class="table-dark">
				<tr>
					<th>#</th>
					<th>Select</th>
					<th>Participant ID</th>
					<th>Name</th>
					<th>Published Date</th>
					<th>Genotypes #</th>
					<th>Variants Loaded</th>
					<th>Download</th>
				</tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>`;
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

/** Trigger a browser download of `content` as a file. */
function downloadAsFile(content, filename, mime = 'text/plain') {
	const blob = new Blob([content], { type: `${mime};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Escape a single CSV field per RFC 4180. */
function csvEscape(value) {
	if (value == null) return '';
	const s = String(value);
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Convert a participants list to CSV using a curated, human-friendly column set. */
function participantsToCsv(list) {
	const cols = [
		'id', 'name', 'age', 'gender', 'race', 'ethnicity', 'valid23File', 'version', 'build', 'sizeMB', 'filename',
		'publishedDate', 'profileUrl', 'downloadUrl', 'finalUrl'
	];
	const rows = list.map((p) => {
		const version = extractVersion(p) ?? '';
		const build = p.genomeBuild ?? p.build ?? '';
		const sizeMB = p.genomeBuildFiles?.[0]?.sizeMB ?? p.sizeMB ?? '';
		const filename = p.gcsfilename ?? p.innerFilename ?? p.filename ?? p.fileName ?? p.genotypes?.[0]?.filename ?? '';
		const published = p.publishedDate ?? p.published_date ?? p.date ?? p.created ?? '';
		return [
			p.id ?? p.participant_id ?? '',
			p.name ?? '',
			p.age ?? '',
			p.gender ?? '',
			p.race ?? '',
			p.ethnicity ?? '',
			p.valid23File == null ? '' : (p.valid23File ? 'true' : 'false'),
			version,
			build,
			sizeMB,
			filename,
			published,
			p.profileUrl ?? p.profile_url ?? '',
			p.downloadUrl ?? p.download_url ?? p.url ?? '',
			p.finalUrl ?? '',
		].map(csvEscape).join(',');
	});
	return [cols.join(','), ...rows].join('\r\n');
}

/**
 * extractVersion(item)
 * Extract 23andMe chip version(s) from a genome filename.
 * Returns a comma-joined string when multiple versions are present,
 * e.g. "genome_Mark_Jones_v2_v3_v5_Full_..." -> "v2,v3,v5".
 * @param {Object} item
 * @returns {string|null}
 */
function extractVersion(item) {
	const filename = item.gcsfilename ?? item.innerFilename ?? item.filename ?? item.fileName ?? item.genotypes?.[0]?.filename ?? item.name ?? '';
	const s = String(filename);
	// Restrict to the "genome_..._Full" section when present to avoid false matches elsewhere
	const section = s.match(/genome_.*?_Full/i)?.[0] ?? s;
	const nums = [...section.matchAll(/_v(\d+)/gi)].map(m => m[1]);
	if (nums.length === 0) return null;
	return nums.map(n => `v${n}`).join(',');
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
	const opts = versions.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${counts.get(v)})</option>`);
	if (counts.has('Unknown')) opts.push(`<option value="Unknown">Unknown (${counts.get('Unknown')})</option>`);
	const prev = new Set(getSelectValues(sel));
	sel.innerHTML = opts.join('');
	restoreSelectValues(sel, prev);
}
window.populateVersionSelect = populateVersionSelect;

/**
 * Populate the build dropdown from the current participants list.
 */
function populateBuildSelect() {
	const sel = document.getElementById('participantsBuildSelect');
	if (!sel) return;
	const counts = new Map();
	participants.forEach((p) => {
		const raw = p.genomeBuild ?? p.build;
		const key = (raw == null || raw === '') ? 'Unknown' : String(raw);
		counts.set(key, (counts.get(key) || 0) + 1);
	});
	const builds = Array.from(counts.keys())
		.filter(k => k !== 'Unknown')
		.sort((a, b) => {
			const na = parseInt(a, 10), nb = parseInt(b, 10);
			if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
			return String(a).localeCompare(String(b));
		});
	const opts = builds.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${counts.get(v)})</option>`);
	if (counts.has('Unknown')) opts.push(`<option value="Unknown">Unknown (${counts.get('Unknown')})</option>`);
	const prev = new Set(getSelectValues(sel));
	sel.innerHTML = opts.join('');
	restoreSelectValues(sel, prev);
}
window.populateBuildSelect = populateBuildSelect;

/** Return an array of selected option values from a <select> (works for multi-select too). */
function getSelectValues(sel) {
	if (!sel) return [];
	return Array.from(sel.selectedOptions ?? []).map(o => o.value).filter(v => v !== '');
}

/** Restore a set of previously-selected values on a <select> after repopulation. */
function restoreSelectValues(sel, prevSet) {
	if (!sel || !prevSet || prevSet.size === 0) return;
	for (const opt of Array.from(sel.options)) {
		if (prevSet.has(opt.value)) opt.selected = true;
	}
}

/**
 * Populate a demographic dropdown (gender / race / ethnicity) from the current
 * participants list. Values with an empty/unknown answer are grouped under "Unknown".
 * @param {string} elementId  target <select> element id
 * @param {'gender'|'race'|'ethnicity'} field  participant field to summarize
 */
function populateDemographicSelect(elementId, field) {
	const sel = document.getElementById(elementId);
	if (!sel) return;
	const isMulti = field === 'raceCategories' || field === 'ethnicityCategories';
	const counts = new Map();
	participants.forEach((p) => {
		if (isMulti) {
			const cats = (Array.isArray(p?.[field]) && p[field].length) ? p[field] : ['Unknown'];
			new Set(cats).forEach(c => counts.set(c, (counts.get(c) || 0) + 1));
		} else {
			const raw = p?.[field];
			const key = (raw == null || raw === '') ? 'Unknown' : String(raw);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
	});
	// Sort alphabetically but push the catch-all buckets to the bottom.
	const rank = (k) => (k === 'Other' ? 1 : (k === 'Unknown' ? 2 : 0));
	const values = Array.from(counts.keys()).sort((a, b) => {
		const ra = rank(a), rb = rank(b);
		if (ra !== rb) return ra - rb;
		return String(a).localeCompare(String(b));
	});
	const opts = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${counts.get(v)})</option>`);
	const prev = new Set(getSelectValues(sel));
	sel.innerHTML = opts.join('');
	restoreSelectValues(sel, prev);
}

function populateGenderSelect() { populateDemographicSelect('participantsGenderSelect', 'gender'); }
function populateRaceSelect() { populateDemographicSelect('participantsRaceSelect', 'raceCategories'); }
function populateEthnicitySelect() { populateDemographicSelect('participantsEthnicitySelect', 'ethnicityCategories'); }
window.populateGenderSelect = populateGenderSelect;
window.populateRaceSelect = populateRaceSelect;
window.populateEthnicitySelect = populateEthnicitySelect;

/**
 * Apply all filters (version, build, size range) to participants and re-render the table.
 * @returns {void}
 */
function applyParticipantFilters() {
	const versionSel = document.getElementById('participantsVersionSelect');
	const buildSel = document.getElementById('participantsBuildSelect');
	const genderSel = document.getElementById('participantsGenderSelect');
	const raceSel = document.getElementById('participantsRaceSelect');
	const ethnicitySel = document.getElementById('participantsEthnicitySelect');
	const sizeMinEl = document.getElementById('participantsSizeMin');
	const sizeMaxEl = document.getElementById('participantsSizeMax');
	const versions = getSelectValues(versionSel);
	const builds = getSelectValues(buildSel);
	const genders = getSelectValues(genderSel);
	const races = getSelectValues(raceSel);
	const ethnicities = getSelectValues(ethnicitySel);
	const sizeMinRaw = sizeMinEl?.value ?? '';
	const sizeMaxRaw = sizeMaxEl?.value ?? '';
	const sizeMin = sizeMinRaw === '' ? null : Number(sizeMinRaw);
	const sizeMax = sizeMaxRaw === '' ? null : Number(sizeMaxRaw);

	let list = participants;

	if (versions.length > 0) {
		const set = new Set(versions);
		list = list.filter(p => set.has(extractVersion(p) ?? 'Unknown'));
	}
	if (builds.length > 0) {
		const set = new Set(builds);
		list = list.filter(p => {
			const raw = p.genomeBuild ?? p.build;
			const key = (raw == null || raw === '') ? 'Unknown' : String(raw);
			return set.has(key);
		});
	}
	const filterByDemographic = (arr, field, multi) => {
		if (arr.length === 0) return;
		const set = new Set(arr);
		list = list.filter(p => {
			if (multi) {
				const cats = (Array.isArray(p?.[field]) && p[field].length) ? p[field] : ['Unknown'];
				return cats.some(c => set.has(c));
			}
			const raw = p?.[field];
			const key = (raw == null || raw === '') ? 'Unknown' : String(raw);
			return set.has(key);
		});
	};
	filterByDemographic(genders, 'gender', false);
	filterByDemographic(races, 'raceCategories', true);
	filterByDemographic(ethnicities, 'ethnicityCategories', true);
	if (sizeMin != null || sizeMax != null) {
		list = list.filter(p => {
			const n = Number(p.genomeBuildFiles?.[0]?.sizeMB ?? p.sizeMB);
			if (!Number.isFinite(n)) return false;
			if (sizeMin != null && n < sizeMin) return false;
			if (sizeMax != null && n > sizeMax) return false;
			return true;
		});
	}

	// Hide build/size/demographic filter controls when not in JSON mode (fields aren't available)
	const buildDiv = document.getElementById('participantsBuildFilterDiv');
	const sizeDiv = document.getElementById('participantsSizeFilterDiv');
	const genderDiv = document.getElementById('participantsGenderFilterDiv');
	const raceDiv = document.getElementById('participantsRaceFilterDiv');
	const ethnicityDiv = document.getElementById('participantsEthnicityFilterDiv');
	const showJsonOnly = participantLoadMode === 'json';
	if (buildDiv) buildDiv.style.display = showJsonOnly ? '' : 'none';
	if (sizeDiv) sizeDiv.style.display = showJsonOnly ? '' : 'none';
	if (genderDiv) genderDiv.style.display = showJsonOnly ? '' : 'none';
	if (raceDiv) raceDiv.style.display = showJsonOnly ? '' : 'none';
	if (ethnicityDiv) ethnicityDiv.style.display = showJsonOnly ? '' : 'none';

	const key = sanitizeKey('participants') || 'participants';
	const summarize = (arr) => arr.length <= 2 ? arr.join('/') : `${arr.length} selected`;
	const labelParts = [];
	if (versions.length) labelParts.push(summarize(versions));
	if (builds.length) labelParts.push(`build ${summarize(builds)}`);
	if (genders.length) labelParts.push(summarize(genders));
	if (races.length) labelParts.push(summarize(races));
	if (ethnicities.length) labelParts.push(summarize(ethnicities));
	if (sizeMin != null || sizeMax != null) labelParts.push(`${sizeMin ?? 0}–${sizeMax ?? '∞'} MB`);
	const filterLabel = labelParts.length ? labelParts.join(', ') : 'All';
	// Update the "Filters · N active" badge on the collapse toggle.
	const activeCount = [versions, builds, genders, races, ethnicities].filter(a => a.length > 0).length
		+ ((sizeMin != null || sizeMax != null) ? 1 : 0);
	const badge = document.getElementById('activeFilterBadge');
	if (badge) {
		if (activeCount > 0) {
			badge.textContent = `${activeCount} active`;
			badge.style.display = '';
		} else {
			badge.style.display = 'none';
		}
	}
	renderParticipantsTable(list, 'localUsersDiv', `Personal Genome Project Participants (${list.length}) - ${filterLabel}`, key);
}
window.applyParticipantFilters = applyParticipantFilters;

/**
 * Handler invoked when the version dropdown changes; filters participants and re-renders the table.
 * @param {string} selectedVersion
 * @returns {void}
 */
window.onParticipantsVersionChange = function onParticipantsVersionChange() {
	applyParticipantFilters();
};

window.onParticipantsBuildChange = function onParticipantsBuildChange() {
	applyParticipantFilters();
};

window.onParticipantsSizeChange = function onParticipantsSizeChange() {
	applyParticipantFilters();
};

window.onParticipantsGenderChange = function onParticipantsGenderChange() {
	applyParticipantFilters();
};

window.onParticipantsRaceChange = function onParticipantsRaceChange() {
	applyParticipantFilters();
};

window.onParticipantsEthnicityChange = function onParticipantsEthnicityChange() {
	applyParticipantFilters();
};

/**
 * Handler invoked when the load-mode toggle changes ('all' vs 'json').
 * @param {'all'|'json'} mode
 */
window.onParticipantsModeChange = async function onParticipantsModeChange(mode) {
	participantLoadMode = mode === 'json' ? 'json' : 'all';
	// Reset sort state when leaving JSON mode
	if (participantLoadMode !== 'json') sortState = { key: null, dir: 'asc' };
	if (mode === 'json') {
		if (!curatedJsonParticipants) {
			showParticipantsLoadingOverlay(true, 20, 'Loading curated JSON list...');
			try {
				const res = await fetch('data/pgp_participants_1017_with_profiles.json');
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const raw = await res.json();
				curatedJsonParticipants = Array.isArray(raw) ? raw.map(flattenCuratedRecord) : [];
			} catch (err) {
				console.error('Failed to load curated JSON:', err);
				curatedJsonParticipants = [];
				alert(`Failed to load data/pgp_participants_1017_with_profiles.json: ${err.message}`);
			} finally {
				showParticipantsLoadingOverlay(false);
			}
		}
		participants = curatedJsonParticipants ?? [];
		updateAllParticipantsCacheInfoUI();
	} else {
		const allBtn = document.getElementById('modeAllBtn');
		const fromCache = !!allParticipantsFast;
		if (!allParticipantsFast) {
			showParticipantsLoadingOverlay(true, 20, 'Fetching all participants...');
			try {
				allParticipantsFast = await allUsersMetaDataByType_fast();
				allParticipantsFetchedAt = new Date().toISOString();
				try {
					await localforage.setItem(ALL_PARTICIPANTS_CACHE_KEY, {
						data: allParticipantsFast,
						fetchedAt: allParticipantsFetchedAt,
					});
				} catch (cacheErr) {
					console.warn('Failed to cache All Participants:', cacheErr);
				}
			} catch (err) {
				console.error('allUsersMetaDataByType_fast error:', err);
				allParticipantsFast = [];
			} finally {
				showParticipantsLoadingOverlay(false);
			}
		}
		participants = allParticipantsFast ?? [];
		if (allBtn) {
			allBtn.textContent = fromCache
				? `From PGP (${participants.length}, cached)`
				: `Fetch from PGP (${participants.length})`;
		}
		updateAllParticipantsCacheInfoUI();
	}

	populateVersionSelect();
	populateBuildSelect();
	populateGenderSelect();
	populateRaceSelect();
	populateEthnicitySelect();
	applyParticipantFilters();
};

/**
 * Force a re-fetch of the All-Participants list, overwriting the cache and timestamp.
 */
window.refreshAllParticipants = async function refreshAllParticipants() {
	const allBtn = document.getElementById('modeAllBtn');
	const updateBtn = document.getElementById('allParticipantsUpdateBtn');
	if (updateBtn) updateBtn.disabled = true;
	showParticipantsLoadingOverlay(true, 20, 'Re-fetching all participants...');
	try {
		const fresh = await allUsersMetaDataByType_fast();
		allParticipantsFast = fresh ?? [];
		allParticipantsFetchedAt = new Date().toISOString();
		try {
			await localforage.setItem(ALL_PARTICIPANTS_CACHE_KEY, {
				data: allParticipantsFast,
				fetchedAt: allParticipantsFetchedAt,
			});
		} catch (cacheErr) {
			console.warn('Failed to cache All Participants:', cacheErr);
		}
		if (participantLoadMode === 'all') {
			participants = allParticipantsFast;
			if (allBtn) allBtn.textContent = `From PGP (${participants.length}, cached)`;
			populateVersionSelect();
			populateBuildSelect();
			populateGenderSelect();
			populateRaceSelect();
			populateEthnicitySelect();
			applyParticipantFilters();
		}
		updateAllParticipantsCacheInfoUI();
	} catch (err) {
		console.error('refreshAllParticipants failed:', err);
		alert(`Failed to refresh All Participants: ${err.message}`);
	} finally {
		showParticipantsLoadingOverlay(false);
		if (updateBtn) updateBtn.disabled = false;
	}
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
		// Sort a copy of the list based on the current sortState
		const sortGetters = {
			version: (p) => {
				const v = extractVersion(p);
				if (!v) return -Infinity;
				const m = v.match(/v(\d+)/i);
				return m ? parseInt(m[1], 10) : -Infinity;
			},
			build: (p) => {
				const n = parseInt(p.genomeBuild ?? p.build, 10);
				return Number.isFinite(n) ? n : -Infinity;
			},
			size: (p) => {
				const n = Number(p.genomeBuildFiles?.[0]?.sizeMB ?? p.sizeMB);
				return Number.isFinite(n) ? n : -Infinity;
			},
		};
		let displayList = list;
		if (participantLoadMode === 'json' && sortState.key && sortGetters[sortState.key]) {
			const get = sortGetters[sortState.key];
			const mult = sortState.dir === 'asc' ? 1 : -1;
			displayList = [...list].sort((a, b) => {
				const av = get(a), bv = get(b);
				if (av === bv) return 0;
				return (av < bv ? -1 : 1) * mult;
			});
		}
		const sortable = participantLoadMode === 'json';
		const sortArrow = (k) => !sortable ? '' : (sortState.key === k ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅');
		const sortAttrs = (k) => sortable ? `class="sortable" data-sort="${k}" style="cursor:pointer;user-select:none;"` : '';

		const totalPages = Math.max(1, Math.ceil(displayList.length / ROWS_PER_PAGE));
		currentPage = Math.min(Math.max(1, currentPage), totalPages);
		const startIndex = (currentPage - 1) * ROWS_PER_PAGE;
		const pageItems = displayList.slice(startIndex, startIndex + ROWS_PER_PAGE);

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
			const downloadHtml = downloadUrl
				? `<a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener" title="${escapeHtml(downloadUrl)}">${escapeHtml(truncateUrlForDisplay(downloadUrl))}</a>`
				: "-";
			const checked = selectedIds.has(String(rawId)) ? 'checked' : '';
			const version = extractVersion(p) ?? '-';

			// Curated-JSON extras
			const filename = p.gcsfilename ?? p.innerFilename ?? p.filename ?? p.fileName ?? p.genotypes?.[0]?.filename ?? '';
			const filenameHtml = filename ? escapeHtml(filename) : '-';
			const build = p.genomeBuild ?? p.build ?? '-';
			const sizeMB = p.genomeBuildFiles?.[0]?.sizeMB ?? p.sizeMB ?? null;
			const sizeHtml = (sizeMB != null) ? `${Number(sizeMB).toFixed(2)}` : '-';

			// New demographic / validity columns
			const ageHtml = (p.age != null && p.age !== '') ? escapeHtml(String(p.age)) : '-';
			const genderHtml = p.gender ? escapeHtml(String(p.gender)) : '-';
			const raceCats = (Array.isArray(p.raceCategories) && p.raceCategories.length) ? p.raceCategories.join(', ') : (p.race || '');
			const ethnicityCats = (Array.isArray(p.ethnicityCategories) && p.ethnicityCategories.length) ? p.ethnicityCategories.join(', ') : (p.ethnicity || '');
			const raceHtml = raceCats ? escapeHtml(String(raceCats)) : '-';
			const ethnicityHtml = ethnicityCats ? escapeHtml(String(ethnicityCats)) : '-';
			const raceTitle = p.race ? escapeHtml(String(p.race)) : raceHtml;
			const ethnicityTitle = p.ethnicity ? escapeHtml(String(p.ethnicity)) : ethnicityHtml;
			const valid23 = p.valid23File;
			const valid23Html = valid23 === true ? '✓' : (valid23 === false ? '✗' : '-');

			return `
				<tr>
					<td>${startIndex + i + 1}</td>
					<td><input class="participant-select" type="checkbox" value="${escapeHtml(String(rawId))}" ${checked} /></td>
					<td>${pid}</td>
					<td title="${name}">${displayName}</td>
					<td>${ageHtml}</td>
					<td>${genderHtml}</td>
					<td title="${raceTitle}">${raceHtml}</td>
					<td title="${ethnicityTitle}">${ethnicityHtml}</td>
					<td class="text-center">${valid23Html}</td>
					<td>${version}</td>
					<td>${escapeHtml(String(build))}</td>
					<td>${sizeHtml}</td>
					<td class="text-truncate" style="max-width:180px;" title="${escapeHtml(filename)}">${filenameHtml}</td>
					<td>${published}</td>
					<td>${profileHtml}</td>
					<td>${downloadHtml}</td>
				</tr>
			`;
		}).join('');

		// (Selection table in the PRS tab is rendered by renderSelectedUsersTable() —
		//  do NOT clear #prsUsersAction here, or it would wipe on every filter/sort.)

		container.innerHTML = `
			<div class="d-flex justify-content-between align-items-center my-2 flex-wrap gap-2">
				<h5 class="mb-0">${escapeHtml(title)}</h5>
				<div class="d-flex align-items-center gap-2 flex-wrap">
					<button id="downloadJsonBtn_${key}" class="btn btn-outline-secondary btn-sm" style="font-size:0.7rem;padding:2px 6px;" title="Download the currently filtered list as JSON">Download JSON</button>
					<button id="downloadCsvBtn_${key}" class="btn btn-outline-secondary btn-sm" style="font-size:0.7rem;padding:2px 6px;" title="Download the currently filtered list as CSV">Download CSV</button>
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
							<th>Age</th>
							<th>Gender</th>
							<th>Race</th>
							<th>Ethnicity</th>
							<th title="File matched the 23andMe header signature">Valid 23andMe</th>
							<th ${sortAttrs('version')}>Version${sortArrow('version')}</th>
							<th ${sortAttrs('build')}>Build${sortArrow('build')}</th>
							<th ${sortAttrs('size')}>Size (MB)${sortArrow('size')}</th>
							<th style="max-width:180px;">Filename</th>
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
		const downloadJsonBtn = document.getElementById(`downloadJsonBtn_${key}`);
		const downloadCsvBtn = document.getElementById(`downloadCsvBtn_${key}`);
		const rowCheckboxes = Array.from(container.querySelectorAll('.participant-select'));
		const prevPageBtn = document.getElementById(`prevPage_${key}`);
		const nextPageBtn = document.getElementById(`nextPage_${key}`);

		if (downloadJsonBtn) {
			downloadJsonBtn.addEventListener('click', () => {
				downloadAsFile(
					JSON.stringify(displayList, null, 2),
					`PGP_participants_1017.json`,
					'application/json'
				);
			});
		}
		if (downloadCsvBtn) {
			downloadCsvBtn.addEventListener('click', () => {
				downloadAsFile(
					participantsToCsv(displayList),
					`PGP_participants_1017.csv`,
					'text/csv'
				);
			});
		}

		// Sortable column headers
		container.querySelectorAll('th.sortable').forEach((th) => {
			th.addEventListener('click', () => {
				const k = th.dataset.sort;
				if (sortState.key === k) {
					sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
				} else {
					sortState.key = k;
					sortState.dir = 'asc';
				}
				currentPage = 1;
				renderPage();
			});
		});

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
						const limitMsg = document.getElementById('selectionLimitMsg');
						if (limitMsg) {
							limitMsg.style.display = '';
							limitMsg.classList.remove('flash-attention');
							void limitMsg.offsetWidth; // restart animation
							limitMsg.classList.add('flash-attention');
						}
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

		// Re-apply the selection limit (disable unchecked rows) after each (re)render
		updateSelectionAvailability();
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

// populate filter selects after definitions
populateVersionSelect();
populateBuildSelect();
populateGenderSelect();
populateRaceSelect();
populateEthnicitySelect();

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

		// (Selection table in the PRS tab is populated via renderSelectedUsersTable()
		//  from updateGlobalSelectionCount(); no need to clear #prsUsersAction here.)

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
					name: file.name,
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

// --- Option D: Load by list of IDs (URLs looked up from curated list) ---
const loadByUrlBtn = document.getElementById("loadByUrlBtn");
const loadByUrlExampleBtn = document.getElementById("loadByUrlExampleBtn");
if (loadByUrlExampleBtn) {
	loadByUrlExampleBtn.addEventListener("click", () => {
		const idsInput = document.getElementById("loadByUrlIds");
		if (idsInput) idsInput.value = "huA08F4D, huC8B936";
	});
}

/** Split a free-form list of IDs (comma / whitespace / newline separated) into a
 *  de-duplicated array, preserving order. */
function parseIdList(raw) {
	if (!raw) return [];
	const seen = new Set();
	const out = [];
	for (const token of String(raw).split(/[\s,;]+/)) {
		const id = token.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

if (loadByUrlBtn) {
	loadByUrlBtn.addEventListener("click", async () => {
		const idsInput = document.getElementById("loadByUrlIds");
		const statusEl = document.getElementById("loadByUrlStatus");
		const allIds = parseIdList(idsInput?.value);

		if (allIds.length === 0) {
			if (statusEl) statusEl.textContent = "Enter at least one participant ID.";
			return;
		}

		// Cap the list at MAX_SELECTION IDs
		const ids = allIds.slice(0, MAX_SELECTION);
		const truncated = allIds.length - ids.length;

		// Build a quick lookup from the curated participants list
		const byId = new Map();
		for (const p of participants) {
			const pid = p?.id ?? p?.participant_id;
			if (pid) byId.set(String(pid), p);
		}

		loadByUrlBtn.disabled = true;
		const messages = [];
		if (truncated > 0) {
			messages.push(`\u26A0 Only the first ${MAX_SELECTION} IDs will be processed (${truncated} ignored).`);
		}

		try {
			for (const id of ids) {
				if (selectedUserIds.has(id)) {
					messages.push(`\u26A0 ${escapeHtml(id)}: already selected.`);
					continue;
				}
				if (selectedUserIds.size >= MAX_SELECTION) {
					messages.push(`\u26A0 ${escapeHtml(id)}: max selection (${MAX_SELECTION}) reached.`);
					break;
				}

				const record = byId.get(id);
				if (!record) {
					messages.push(`\u2717 ${escapeHtml(id)}: not found in curated participants list.`);
					continue;
				}
				const url = record.downloadUrl ?? record.download_url ?? record.url ?? null;
				if (!url) {
					messages.push(`\u2717 ${escapeHtml(id)}: no download URL in curated list.`);
					continue;
				}

				if (statusEl) statusEl.textContent = `Loading ${id}...`;

				try {
					let parsed = await get23Txt(url, id, false);
					if (!parsed || !parsed.dt) {
						throw new Error("get23Txt did not return expected parsed data.");
					}
					const innerFilename = parsed.filename ?? '';
					const finalUrl = parsed.finalUrl ?? parsed.meta?.finalUrl ?? record.finalUrl ?? url;
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
						name: record.name || nameFromFilename(innerFilename || record.filename || finalUrl) || id,
						fileName: innerFilename || record.filename || String(finalUrl).split("/").pop() || id,
						dataSource: "url",
						dataType: record.dataType || "23andMe",
						downloadUrl: url,
						finalUrl,
						profileUrl: record.profileUrl ?? null,
						publishedDate: record.publishedDate ?? new Date().toISOString().slice(0, 10),
						_parsed: parsed,
					};

					selectedUserIds.add(id);
					selectedUsersMap.set(id, user);
					updateGlobalSelectionCount();

					messages.push(`\u2713 ${escapeHtml(id)}: ${parsed.dt.length.toLocaleString()} variants loaded and cached.`);
				} catch (err) {
					console.error(`Load by ID failed for ${id}:`, err);
					messages.push(`\u2717 ${escapeHtml(id)}: ${escapeHtml(err.message)}`);
				}
			}

			if (statusEl) statusEl.innerHTML = messages.join('<br>');
			if (idsInput) idsInput.value = "";
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
	populateBuildSelect,
	populateGenderSelect,
	populateRaceSelect,
	populateEthnicitySelect,
	onParticipantsVersionChange: window.onParticipantsVersionChange,
	onParticipantsBuildChange: window.onParticipantsBuildChange,
	onParticipantsSizeChange: window.onParticipantsSizeChange,
	onParticipantsGenderChange: window.onParticipantsGenderChange,
	onParticipantsRaceChange: window.onParticipantsRaceChange,
	onParticipantsEthnicityChange: window.onParticipantsEthnicityChange,
	onParticipantsModeChange: window.onParticipantsModeChange,
	onPgsSelectionChange: window.onPgsSelectionChange,
});
//# sourceMappingURL=displayUsers-D55vGQMZ.mjs.map

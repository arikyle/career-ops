#!/usr/bin/env node
// set-status.mjs — update application status in the tracker
// Called by the dashboard (--report-link REPORT STATUS) and CLI (--row N STATUS).
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, join, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// ── Argument parsing ─────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a.startsWith('--note=')) {
    flags.note = a.slice(7);
  } else if (a === '--note') {
    flags.note = rawArgs[++i];
  } else if (a === '--row') {
    flags.row = rawArgs[++i];
  } else if (a === '--report-link') {
    flags.reportLink = rawArgs[++i];
  } else if (a === '--source') {
    flags.source = rawArgs[++i];
  } else if (a === '--json') {
    flags.json = true;
  } else if (a === '--detach-jd-archive') {
    // ignored — archive runs async via shell detach in the upstream implementation
  } else if (a === '--repair-status-log') {
    flags.repairStatusLog = true;
  } else if (a === '--repair-followup') {
    flags.repairFollowup = true;
  } else if (!a.startsWith('--')) {
    positional.push(a);
  }
}

const rawNewStatus = positional[0];
const source = flags.source || 'set-status';

function die(msg) {
  if (flags.json) process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  else process.stderr.write(msg + '\n');
  process.exit(1);
}

if (!rawNewStatus) die('set-status.mjs: missing STATUS argument');

const trackerPath = process.env.CAREER_OPS_TRACKER;
if (!trackerPath) die('CAREER_OPS_TRACKER not set');

// ── Status normalization ─────────────────────────────────────────────────────

function normalizeStatus(s) {
  if (s.toLowerCase() === 'skip') return 'SKIP';
  return s;
}

const newStatus = normalizeStatus(rawNewStatus);

// ── Canonical status validation ───────────────────────────────────────────────

const CANONICAL_STATUSES = new Set([
  'evaluated', 'applied', 'responded', 'assessment', 'interview',
  'offer', 'hired', 'rejected', 'discarded', 'skip',
]);

function isCanonicalStatus(s) {
  return CANONICAL_STATUSES.has(s.toLowerCase());
}

// ── Tracker lock ─────────────────────────────────────────────────────────────

const LOCK_PREFIX = 'career-ops-merge-tracker-';

function canonicalPath(p) {
  try { return realpathSync(p); } catch { return p; }
}

function trackerLockDirFor(trackerAbsPath) {
  const canonTracker = canonicalPath(trackerAbsPath);
  const canonTmp = canonicalPath(tmpdir());
  const hash = createHash('sha256').update(canonTracker).digest('hex').slice(0, 16);
  const fallback = join(canonTmp, `${LOCK_PREFIX}${hash}.lock`);

  const override = process.env.CAREER_OPS_TRACKER_LOCK || '';
  if (override && isAbsolute(override)) {
    const candidate = override;
    const candidateParent = canonicalPath(dirname(candidate));
    const inTmp = candidateParent === canonTmp || candidateParent.startsWith(canonTmp + '/');
    if (inTmp && basename(candidate).startsWith(LOCK_PREFIX)) {
      return candidate;
    }
  }
  return fallback;
}

function acquireTrackerLockSync(lockDir, timeoutMs, retryMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { recursive: false });
      return true; // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // busy-wait with synchronous sleep approximation
    const wait = Math.min(retryMs, deadline - Date.now());
    if (wait <= 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
  return false; // timed out
}

function releaseTrackerLock(lockDir) {
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const timeoutMs = Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 30_000;
const retryMs = Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75;
const lockDir = trackerLockDirFor(trackerPath);

const acquired = acquireTrackerLockSync(lockDir, timeoutMs, retryMs);
if (!acquired) die('tracker lock timeout: another process holds the tracker lock');

// ── Table helpers ─────────────────────────────────────────────────────────────

const ALIASES = {
  '#': 'num', 'num': 'num',
  'date': 'date', 'fecha': 'date', 'datum': 'date', 'data': 'date',
  'dato': 'date', 'tanggal': 'date',
  'company': 'company', 'empresa': 'company',
  'firma': 'company', 'virksomhed': 'company', 'perusahaan': 'company',
  'via': 'via', 'role': 'role', 'puesto': 'role',
  'rolle': 'role', 'rola': 'role', 'vaga': 'role',
  'location': 'location', 'ort': 'location',
  'score': 'score', 'status': 'status',
  'pdf': 'pdf', 'materials': 'pdf', 'report': 'report',
  'apply link': 'applylink', 'apply': 'applylink',
  'follow-up': 'followup', 'follow up': 'followup', 'followup': 'followup',
  'notes': 'notes', 'url': 'url',
};

// Mirrors Go's splitTrackerRow: tab-delimited when line contains a tab and
// has at most two pipes; otherwise pure pipe-delimited.
function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return { cells: [], isTab: false };
  const pipeCount = (t.match(/\|/g) || []).length;
  if (t.includes('\t') && pipeCount <= 2) {
    // Mixed format: leading "|" then tab-separated fields.
    let s = t.replace(/^\|/, '').trimStart();
    const parts = s.split('\t').map(c => c.trim().replace(/\|$/, '').trim());
    return { cells: parts, isTab: true };
  }
  // Pure pipe format.
  const parts = t.split('|');
  return { cells: parts.slice(1, parts.length - 1).map(c => c.trim()), isTab: false };
}

function isSep(cells) {
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

// ── Read and parse tracker ────────────────────────────────────────────────────

const content = readFileSync(trackerPath, 'utf8');
const lines = content.split('\n');

// Detect header row to map column names → indices
let colMap = null;
for (const line of lines) {
  if (!line.trim().startsWith('|')) continue;
  const { cells } = splitRow(line);
  if (!cells.length || isSep(cells)) continue;
  const m = {};
  cells.forEach((c, i) => {
    const name = ALIASES[c.toLowerCase()];
    if (name) m[name] = i;
  });
  if (['num', 'company', 'role', 'score', 'status'].every(k => k in m)) {
    colMap = m;
    break;
  }
}
if (!colMap) colMap = { num: 0, date: 1, company: 2, role: 3, score: 4, status: 5, pdf: 6, report: 7, notes: 8 };

// ── Find target row ───────────────────────────────────────────────────────────

let targetIdx = -1;
let targetIsTab = false;
let oldStatus = '';
let rowNum = '';
let findError = null;

if (flags.reportLink !== undefined) {
  // Search by report link — must find exactly one unambiguous cell
  const rl = String(flags.reportLink);
  const tag = `[${rl}]`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const { cells, isTab } = splitRow(line);
    if (!cells.length || isSep(cells)) continue;
    const report = colMap.report !== undefined ? (cells[colMap.report] || '') : '';
    if (!report.includes(tag)) continue;
    // Row mentions the report number — validate it's a clean single link
    const clean = report.match(/^\[(\d+)\]\([^)]*\)$/);
    if (!clean || clean[1] !== rl) {
      findError = `malformed report cell: ${report}`;
      break;
    }
    if (targetIdx !== -1) {
      // Second clean match — ambiguous
      findError = `ambiguous report ${rl}: found in multiple rows`;
      break;
    }
    targetIdx = i;
    targetIsTab = isTab;
    oldStatus = colMap.status !== undefined ? (cells[colMap.status] || '') : '';
    rowNum = colMap.num !== undefined ? (cells[colMap.num] || '') : '';
    // continue scanning to detect duplicates
  }
  if (!findError && targetIdx === -1) findError = `report ${rl} not found`;
} else if (flags.row !== undefined) {
  const rn = String(flags.row);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const { cells, isTab } = splitRow(line);
    if (!cells.length || isSep(cells)) continue;
    const num = colMap.num !== undefined ? (cells[colMap.num] || '') : '';
    if (num !== rn) continue;
    targetIdx = i;
    targetIsTab = isTab;
    oldStatus = colMap.status !== undefined ? (cells[colMap.status] || '') : '';
    rowNum = num;
    break;
  }
  if (targetIdx === -1) findError = `row ${rn} not found`;
} else {
  findError = 'neither --row nor --report-link specified';
}

if (findError) {
  releaseTrackerLock(lockDir);
  die(findError);
}

// Strip bold markers (e.g. "**Applied**" → "Applied")
oldStatus = oldStatus.replace(/\*\*/g, '').trim();

// Validate that the current status on disk is recognizable before touching the row.
if (!isCanonicalStatus(oldStatus)) {
  releaseTrackerLock(lockDir);
  die(`unrecognized current status: ${JSON.stringify(oldStatus)}`);
}

const statusChanged = oldStatus.toLowerCase() !== newStatus.toLowerCase();

// ── Update the row ────────────────────────────────────────────────────────────

const { cells } = splitRow(lines[targetIdx]);

if (colMap.status !== undefined) {
  cells[colMap.status] = newStatus;
}

let noteAppended = false;
if (flags.note !== undefined && colMap.notes !== undefined) {
  // Fail if the header defines a notes column but this row doesn't have that cell.
  if (cells.length <= colMap.notes) {
    releaseTrackerLock(lockDir);
    die('notes column is missing from this tracker row');
  }
  const cur = (cells[colMap.notes] || '').trim();
  const note = flags.note.trim();
  const alreadyPresent = cur === note ||
    cur.includes('; ' + note) ||
    cur.startsWith(note + ';');
  if (note && !alreadyPresent) {
    cells[colMap.notes] = cur ? cur + '; ' + note : note;
    noteAppended = true;
  }
}

if (statusChanged || noteAppended) {
  // Reconstruct in the original delimiter format to avoid rewriting legacy rows.
  lines[targetIdx] = targetIsTab
    ? '| ' + cells.join('\t') + ' |'
    : '| ' + cells.join(' | ') + ' |';
  writeFileSync(trackerPath, lines.join('\n'));
}

// Release the tracker lock now that the file is written
releaseTrackerLock(lockDir);

// ── Status log ────────────────────────────────────────────────────────────────

const dataDir = dirname(trackerPath);
const logPath = join(dataDir, 'status-log.tsv');
const today = new Date().toISOString().slice(0, 10);
let statusLogged;
let statusLogRepair;

if (statusChanged) {
  const entry = `${rowNum}\t${today}\t${oldStatus}\t${newStatus}\t${source}\n`;
  try {
    appendFileSync(logPath, entry);
    statusLogged = true;
  } catch (e) {
    statusLogged = false;
    process.stderr.write('status-log append failed: ' + e.message + '\n');
  }
} else if (flags.repairStatusLog && newStatus.toLowerCase() === 'applied') {
  try {
    const logContent = readFileSync(logPath, 'utf8');
    const hasApplied = logContent.split('\n').some(line => {
      const cols = line.split('\t');
      return cols[0] === rowNum && cols[3] && cols[3].toLowerCase() === 'applied';
    });
    if (!hasApplied) {
      appendFileSync(logPath, `${rowNum}\t${today}\t-\tApplied\tcorrection\t\n`);
    }
    statusLogRepair = { repaired: !hasApplied };
  } catch (e) {
    statusLogRepair = { repaired: false, error: e.message };
  }
}

// ── Follow-ups ────────────────────────────────────────────────────────────────

const followupsPath = join(dataDir, 'follow-ups.md');
let followupSeeded;

const shouldSeedFollowup =
  (statusChanged && newStatus.toLowerCase() === 'applied') ||
  (flags.repairFollowup && newStatus.toLowerCase() === 'applied');

if (shouldSeedFollowup) {
  try {
    const existing = existsSync(followupsPath) ? readFileSync(followupsPath, 'utf8') : '';
    const pin = `next #${rowNum} `;
    if (!existing.includes(pin)) {
      writeFileSync(followupsPath, existing + `- [ ] ${pin}follow up\n`);
    }
    followupSeeded = { reason: 'applied' };
  } catch (e) {
    followupSeeded = { reason: 'error', error: e.message };
  }
}

// ── Output result ─────────────────────────────────────────────────────────────

const result = { changed: statusChanged || noteAppended, newStatus };
if (statusLogged !== undefined) result.statusLogged = statusLogged;
if (statusLogRepair !== undefined) result.statusLogRepair = statusLogRepair;
if (followupSeeded !== undefined) result.followupSeeded = followupSeeded;

if (flags.json) process.stdout.write(JSON.stringify(result) + '\n');

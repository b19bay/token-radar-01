// Token Radar — entry program (program/v1, Node 22, standard library only).
//
// Reads the sealed DefiLlama snapshot and writes the ranked board, the
// dashboard's data, the dashboard and screenshots, and dossier.json last.
// Deterministic: no wall-clock time, no randomness, no network.
//
//   node main.ts --input <snapshot.json|dir> --output <dir>
// Defaults: --input /input, --output $MAKEFUN_OUTPUT_DIR or /output.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  MODEL_CONSTANTS,
  MODEL_VERSION,
  buildFarmSteps,
  computePeerTable,
  recordsToken,
  scoreProtocol,
  setAsideReason,
} from './lib/model.ts';
import type { BoardRow, Snapshot, SnapshotProtocol } from './lib/model.ts';

const TEXT_MAX_BYTES = 65536;
const SCREENSHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function fail(message: string): never {
  console.error(`token-radar: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = '/input';
  let output = process.env.MAKEFUN_OUTPUT_DIR !== undefined && process.env.MAKEFUN_OUTPUT_DIR !== '' ? process.env.MAKEFUN_OUTPUT_DIR : '/output';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--input') {
      const next = argv[i + 1];
      if (next === undefined) fail('--input needs a value');
      input = next;
      i++;
    } else if (arg.startsWith('--input=')) {
      input = arg.slice('--input='.length);
    } else if (arg === '--output') {
      const next = argv[i + 1];
      if (next === undefined) fail('--output needs a value');
      output = next;
      i++;
    } else if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { input, output };
}

function readSnapshot(inputPath: string): Snapshot {
  let file = inputPath;
  let st;
  try {
    st = statSync(inputPath);
  } catch {
    fail(`cannot read input: ${inputPath}`);
  }
  if (st.isDirectory()) file = join(inputPath, 'snapshot.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    fail(`cannot read snapshot file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`snapshot is not valid JSON: ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('snapshot must be a JSON object');
  }
  const snap = parsed as Record<string, unknown>;
  if (typeof snap.as_of !== 'string' || typeof snap.source !== 'string') {
    fail('snapshot needs as_of and source strings');
  }
  if (typeof snap.floor_usd !== 'number') fail('snapshot needs a floor_usd number');
  if (!Array.isArray(snap.protocols) || snap.protocols.length === 0) {
    fail('snapshot needs a non-empty protocols array');
  }
  if (!Array.isArray(snap.watchlist) || snap.watchlist.length === 0) {
    fail('snapshot needs a non-empty watchlist array');
  }
  for (const p of snap.protocols as unknown[]) {
    if (typeof p !== 'object' || p === null) fail('every protocol must be an object');
    const proto = p as Record<string, unknown>;
    if (typeof proto.slug !== 'string' || proto.slug === '' || typeof proto.name !== 'string' || proto.name === '') {
      fail('every protocol needs a non-empty slug and name');
    }
    if (typeof proto.tvl_usd !== 'number' || !Number.isFinite(proto.tvl_usd)) {
      fail(`protocol ${String(proto.slug)} needs a finite tvl_usd`);
    }
    if (!Array.isArray(proto.chains)) fail(`protocol ${String(proto.slug)} needs a chains array`);
  }
  return parsed as Snapshot;
}

function copyTree(srcDir: string, destDir: string, label: string): string[] {
  const copied: string[] = [];
  const walk = (rel: string): void => {
    const dir = rel === '' ? srcDir : join(srcDir, rel);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      fail(`cannot read ${label} directory: ${dir}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const src = join(srcDir, relPath);
      const dest = join(destDir, relPath);
      if (entry.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        walk(relPath);
      } else if (entry.isFile()) {
        cpSync(src, dest);
        copied.push(relPath);
      } else {
        fail(`${label}/${relPath} is neither a file nor a directory`);
      }
    }
  };
  mkdirSync(destDir, { recursive: true });
  walk('');
  return copied;
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const outDir = resolve(output);
  const snapshot = readSnapshot(resolve(input));
  const protocols = snapshot.protocols;
  const watchlist = snapshot.watchlist;
  const watchlistSet = new Set(watchlist);

  const peerTable = computePeerTable(protocols);

  // Split the universe: live-token, set-aside pre-token, rankable pre-token.
  const live: SnapshotProtocol[] = [];
  const aside: { protocol: SnapshotProtocol; reason: string }[] = [];
  const rankable: SnapshotProtocol[] = [];
  for (const p of protocols) {
    if (recordsToken(p)) {
      live.push(p);
      continue;
    }
    const reason = setAsideReason(p);
    if (reason !== null) aside.push({ protocol: p, reason });
    else rankable.push(p);
  }

  // Score and rank: implied value desc, TVL desc, slug asc as tiebreak.
  const scored = rankable.map((p) => scoreProtocol(p, peerTable, snapshot.as_of));
  scored.sort((a, b) => {
    if (b.implied_value_usd !== a.implied_value_usd) return b.implied_value_usd - a.implied_value_usd;
    if (b.protocol.tvl_usd !== a.protocol.tvl_usd) return b.protocol.tvl_usd - a.protocol.tvl_usd;
    return a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0;
  });

  const rows: BoardRow[] = scored.map((s, index) => {
    const p = s.protocol;
    return {
      rank: index + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains.slice(),
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: null,
      listed_at: p.listed_at,
      age_days: s.age_days,
      implied_value_usd: s.implied_value_usd,
      token_status: 'pre-token',
      watchlist: watchlistSet.has(p.slug),
      model: s.model,
      farm_steps: buildFarmSteps(p, s.age_days),
    };
  });

  // ---- self-checks (fail loudly, exit non-zero) ----
  const rowSlugs = new Set(rows.map((r) => r.slug));
  const missingWatchlist = watchlist.filter((slug) => !rowSlugs.has(slug));
  if (missingWatchlist.length > 0) {
    fail(`watchlist slugs missing from the board: ${missingWatchlist.slice(0, 10).join(', ')}`);
  }
  if (rows.length < 100) fail(`board holds only ${rows.length} rows, need at least 100`);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as BoardRow;
    if (row.rank !== i + 1) fail(`rank mismatch at index ${i}: got ${row.rank}`);
    if (i > 0 && (rows[i - 1] as BoardRow).implied_value_usd < row.implied_value_usd) {
      fail(`implied value rises at rank ${row.rank}`);
    }
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      fail(`row ${row.slug} has a bad implied value`);
    }
    const steps = row.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) {
      fail(`row ${row.slug} has ${steps.length} farm steps, need 3 to 12`);
    }
    for (const step of steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) fail(`row ${row.slug} has a farm step of ${len} chars, need 20 to 600`);
    }
  }
  const allEqual = rows.every((r) => r.implied_value_usd === (rows[0] as BoardRow).implied_value_usd);
  if (allEqual) fail('all implied values are equal: not a ranking');

  // Live-token comparison set: top 24 by market cap.
  const liveSorted = live.slice().sort((a, b) => (b.mcap_usd ?? -1) - (a.mcap_usd ?? -1));
  const liveRows = liveSorted.slice(0, 24).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains.slice(),
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    fdv_tvl: p.mcap_usd === null || p.tvl_usd <= 0 ? null : Math.round((p.mcap_usd / p.tvl_usd) * 10000) / 10000,
  }));

  // Set-aside protocols: top 40 by TVL, with their reason label.
  const asideSorted = aside.slice().sort((a, b) => b.protocol.tvl_usd - a.protocol.tvl_usd);
  const asideRows = asideSorted.slice(0, 40).map((a) => ({
    slug: a.protocol.slug,
    name: a.protocol.name,
    category: a.protocol.category,
    chains: a.protocol.chains.slice(),
    tvl_usd: a.protocol.tvl_usd,
    reason: a.reason,
  }));
  const asideCounts: Record<string, number> = {};
  for (const a of aside) asideCounts[a.reason] = (asideCounts[a.reason] ?? 0) + 1;

  const totalImplied = rows.reduce((sum, r) => sum + r.implied_value_usd, 0);
  const sortedImplied = rows.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const medianImplied = sortedImplied[Math.floor(sortedImplied.length / 2)] as number;

  const peerTableOut = peerTable.by_category.map((e) => ({
    category: e.category,
    multiple: e.multiple,
    peer_count: e.peer_count,
    fallback: e.fallback,
  }));
  peerTableOut.push({
    category: 'Global fallback',
    multiple: peerTable.global_multiple,
    peer_count: peerTable.global_peer_count,
    fallback: true,
  });

  const data = {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      model_version: MODEL_VERSION,
      constants: MODEL_CONSTANTS,
      totals: {
        protocols_scanned: protocols.length,
        ranked: rows.length,
        watchlist: watchlist.length,
        set_aside: aside.length,
        live: live.length,
      },
      total_implied_usd: totalImplied,
      median_implied_usd: medianImplied,
    },
    peer_table: peerTableOut,
    rows,
    live_rows: liveRows,
    aside_rows: asideRows,
    aside_counts: asideCounts,
  };

  // ---- write outputs ----
  // Empty the output directory's CONTENTS without removing the directory
  // itself: in the grader /output is a bind mount on a read-only root
  // filesystem, so removing it fails (EACCES/EBUSY) and kills the run.
  // Only its children may be deleted.
  mkdirSync(outDir, { recursive: true });
  for (const child of readdirSync(outDir)) {
    rmSync(join(outDir, child), { recursive: true, force: true });
  }
  writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows }, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'data.js'), `window.RADAR = ${JSON.stringify(data)};\n`, 'utf8');

  const repoRoot = dirname(fileURLToPath(import.meta.url));
  copyTree(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'), 'dashboard');
  const shots = copyTree(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'), 'screenshots');
  if (shots.length < 3) fail(`screenshots/ holds only ${shots.length} images, need at least 3`);
  for (const name of shots) {
    if (!SCREENSHOT_NAME.test(name)) fail(`screenshot name not allowed: ${name}`);
    const st = lstatSync(join(outDir, 'screenshots', name));
    if (st.size > 512 * 1024) fail(`screenshot ${name} is ${st.size} bytes, over the 512 KiB cap`);
  }

  // Dossier last, from the vendored library, exactly as the scorer rebuilds it.
  const dossier = buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES });
  writeFileSync(join(outDir, 'dossier.json'), dossier);
  if (dossier.length > 1.5 * 1024 * 1024) fail(`dossier.json is ${dossier.length} bytes, over the 1.5 MiB cap`);

  console.log(`token-radar: as_of=${snapshot.as_of} scanned=${protocols.length} ranked=${rows.length} watchlist=${watchlist.length} set_aside=${aside.length} live=${live.length}`);
  console.log(`token-radar: top implied $${(rows[0] as BoardRow).implied_value_usd.toLocaleString('en-US')} (${(rows[0] as BoardRow).slug}), total implied $${totalImplied.toLocaleString('en-US')}`);
  console.log(`token-radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dossier.json')}`);
}

main();

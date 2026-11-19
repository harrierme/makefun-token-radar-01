// Token Radar's entry point, rewritten for the resubmission round (Node 22,
// standard library only).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input
// <file|dir>), scores every pre-token protocol with the model in lib/model.ts,
// writes the ranked board to /output/board.json, writes the dashboard's data
// beside the page as data.js, copies dashboard/ and screenshots/ to /output,
// and writes /output/dossier.json with the dossier builder in vendor/.
//
// The dashboard is a static page, no framework and no network: dashboard/
// reads data.js, which this program writes from the same board, so the page
// and board.json always show the same numbers.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleBoard, boardProblem, parseFeed, radarScript } from './lib/model.ts';
import { makeDossier } from './vendor/makefun-board.ts';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_CAP = 65536;
const SHOT_COUNT_CAP = 4;
const SHOT_BYTES_CAP = 524288;
const DASH_FILE_CAP = 400;
const DASH_BYTES_CAP = 4194304;

/** A plain file name: a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them. */
function isPlainName(name: string): boolean {
  if (name.length < 1 || name.length > 128) return false;
  const first = name.charCodeAt(0);
  const firstOk =
    (first >= 48 && first <= 57) || (first >= 65 && first <= 90) || first === 95 || (first >= 97 && first <= 122);
  if (!firstOk) return false;
  for (let i = 1; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      c === 95 ||
      (c >= 97 && c <= 122) ||
      c === 46 ||
      c === 45;
    if (!ok) return false;
  }
  return true;
}

/** Read `--name <value>` or `--name=<value>` out of the arguments, else the fallback. */
function optionValue(argv: string[], name: string, fallback: string): string {
  const flag = '--' + name;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === flag && i + 1 < argv.length) return argv[i + 1]!;
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return fallback;
}

function die(message: string, code: number): never {
  process.stderr.write(message + '\n');
  process.exit(code);
}

const args = process.argv.slice(2);
const inputArg = optionValue(args, 'input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  die(
    'token radar: no snapshot at ' + inputFile + ': pass --input <snapshot.json|directory> or mount the sealed /input',
    2,
  );
}
const outDir = optionValue(args, 'output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const feed = parseFeed(readFileSync(inputFile, 'utf8'));
const { board, radar } = assembleBoard(feed);
const problem = boardProblem(board, feed);
if (problem !== null) {
  die('token radar: the model wrote a board the gate refuses: ' + problem, 1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(join(outDir, 'data.js'), radarScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyPlainFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isFile()) continue;
    const src = join(from, entry.name);
    if (!lstatSync(src).isFile()) continue;
    copyFileSync(src, join(to, entry.name));
    names.push(entry.name);
  }
  return names;
}

const dashNames = copyPlainFiles(join(rootDir, 'dashboard'), join(outDir, 'dashboard'));
const shotNames = copyPlainFiles(join(rootDir, 'screenshots'), join(outDir, 'screenshots'));
if (shotNames.length < 3) {
  die(
    'token radar: screenshots/ holds ' + shotNames.length + ' image' + (shotNames.length === 1 ? '' : 's') + ': hand in 3, the board, a detail view and a filtered view',
    1,
  );
}
for (const name of shotNames) {
  if (!isPlainName(name)) {
    die('token radar: screenshots/' + name + ': a name is letters, digits and . _ -, 1 to 128 characters', 1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  makeDossier(outDir, {
    textCap: TEXT_CAP,
    shots: { count: SHOT_COUNT_CAP, bytes: SHOT_BYTES_CAP },
    files: { count: DASH_FILE_CAP, bytes: DASH_BYTES_CAP },
  }),
);

const summaryLines = [
  'token radar: ' + feed.protocols.length + ' protocols, ' + feed.watchlist.length + ' on the watchlist, ' + board.length + ' rows scored (' + radar.early_size + ' early, ' + radar.live_size + ' live set aside)',
  'token radar: wrote ' + join(outDir, 'board.json') + ', ' + join(outDir, 'data.js') + ', ' + join(outDir, 'dashboard') + ' (' + dashNames.length + ' files), ' + join(outDir, 'screenshots') + ' (' + shotNames.length + ' images) and ' + join(outDir, 'dossier.json'),
];
process.stdout.write(summaryLines.join('\n') + '\n');

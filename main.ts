// Token Radar's entry point, second rewrite (Node 22, standard library only).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input
// <file|dir>), runs the valuation pipeline in lib/model.ts, writes the
// ranked board to /output/board.json, writes the dashboard's data beside
// the page as data.js, copies dashboard/ and screenshots/ to /output, and
// writes /output/dossier.json with the dossier builder in vendor/.
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
import { buildRadar, checkBoard, pageScript, readSnapshot } from './lib/model.ts';
import { assembleDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_CAP = 65_536;
const SCREENSHOT_LIMITS = { count: 4, bytes: 524_288 };
const DASHBOARD_LIMITS = { count: 400, bytes: 4_194_304 };

/** A plain file name: a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Scan the arguments once into `--name value` pairs, both spellings. */
function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 2) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else if (i + 1 < argv.length) {
      flags.set(a.slice(2), argv[i + 1]!);
      i++;
    }
  }
  return flags;
}

function fail(message: string, code: number): never {
  process.stderr.write(message + '\n');
  process.exit(code);
}

/** Copy a directory tree of plain files into `to`, skipping dot names; returns the files copied. */
function copyTree(from: string, to: string, rel = ''): string[] {
  if (!existsSync(from)) return [];
  const copied: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const src = join(dir, entry.name);
      const relPath = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) {
        walk(src, relPath);
      } else if (entry.isFile() && lstatSync(src).isFile()) {
        mkdirSync(join(to, prefix), { recursive: true });
        copyFileSync(src, join(to, relPath));
        copied.push(relPath);
      }
    }
  };
  walk(from, rel);
  return copied;
}

function run(): void {
  const flags = readFlags(process.argv.slice(2));
  const inputArg = flags.get('input') ?? '/input';
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    fail(
      'token radar: no snapshot at ' + inputFile + ': pass --input <snapshot.json|directory> or mount the sealed /input',
      2,
    );
  }
  const outDir = flags.get('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const snapshot = readSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, data } = buildRadar(snapshot);
  const issue = checkBoard(board, snapshot);
  if (issue !== null) {
    fail('token radar: the pipeline wrote a board the gate refuses: ' + issue, 1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
  writeFileSync(join(outDir, 'data.js'), pageScript(data));

  const dashFiles = copyTree(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
  const shotFiles = copyTree(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
  if (shotFiles.length < 3) {
    fail(
      'token radar: screenshots/ holds ' + shotFiles.length + ' image' + (shotFiles.length === 1 ? '' : 's') + ': hand in 3, the board, a detail view and a filtered view',
      1,
    );
  }
  for (const name of shotFiles) {
    if (!PLAIN_NAME.test(name)) {
      fail('token radar: screenshots/' + name + ': a name is letters, digits and . _ -, 1 to 128 characters', 1);
    }
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(
    join(outDir, 'dossier.json'),
    assembleDossier(outDir, {
      textCap: DOSSIER_TEXT_CAP,
      shots: SCREENSHOT_LIMITS,
      files: DASHBOARD_LIMITS,
    }),
  );

  process.stdout.write(
    [
      'token radar: ' + snapshot.protocols.length + ' protocols, ' + snapshot.watchlist.length + ' on the watchlist, ' + board.length + ' rows scored (' + data.early_size + ' early, ' + data.live_size + ' live set aside)',
      'token radar: wrote ' + join(outDir, 'board.json') + ', ' + join(outDir, 'data.js') + ', ' + join(outDir, 'dashboard') + ' (' + dashFiles.length + ' files), ' + join(outDir, 'screenshots') + ' (' + shotFiles.length + ' images) and ' + join(outDir, 'dossier.json'),
    ].join('\n') + '\n',
  );
}

run();

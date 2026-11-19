// make.fun's dashboard-dossier builder for Node 22, rewritten for the
// resubmission round: one file, the Node standard library only, erasable
// TypeScript, so it runs as-is under `node main.ts` with no flags, no build
// and no install. It lives at vendor/makefun-board.ts in the repository and
// main.ts imports it as:
//
//   import { makeDossier } from './vendor/makefun-board.ts';
//   writeFileSync('/output/dossier.json', makeDossier('/output', { textCap: 65536 }));
//
// The bounty's scorer runs the same builder, byte for byte, on what you hand
// in, and requires your dossier.json to equal what it writes from your
// dashboard/ and screenshots/.
//
//   makeDossier(dir, limits)  the dossier (makefun/dossier/v1) of a dashboard
//                             directory, as canonical JSON bytes: the
//                             screenshots plus a text of the page's source
//
// A dossier is one JSON object:
//
//   schema   "makefun/dossier/v1"
//   cover    0: the first screenshot by name is the cover
//   images   the PNG and JPEG files in dir/screenshots/ (names starting with
//            '.' skipped), in name order, each {name, media_type, sha256, base64}
//   text     what the judge reads: a "## Dashboard" block (the file count, the
//            bytes, and every file's path with its size), then "## Source",
//            each text file's path, size and line count and its contents in a
//            fenced block by path, every file by path
//
// The text holds at most limits.textCap UTF-8 bytes: every file that fits goes
// in whole, in path order; the first that does not goes in up to its last
// complete line that fits (its fence closed, then a line naming how many of
// its lines are not shown), or not at all when not one line fits; nothing
// follows it but a last line naming how many whole files and how many bytes
// were left out. A file whose extension is not one of .html .css .js .json
// .mjs .svg .md .txt is named in the Dashboard block and not shown: the text
// is source, and the page's images are not source.
//
// makeDossier refuses (DossierFailure) an empty screenshots/ directory, a
// screenshot name a dossier refuses, a screenshot that is not a whole PNG or
// JPEG, a screenshot past its byte cap or more screenshots than the count cap,
// a dashboard file that is not plain (a link, a dot-directory, a name that is
// not letters, digits and . _ -, a file past its byte cap or more files than
// the count cap), a text cap that cannot hold the Dashboard block and the cut
// line, and a dossier past DOSSIER_LIMIT. The caps only refuse: they never
// shape the bytes. Only textCap shapes them, so a program that passes
// {textCap} and writes the result has written what the scorer, given its
// other caps too, compares byte for byte.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** The dossier schema makeDossier writes. */
export const DOSSIER_ID = 'makefun/dossier/v1';
/** The most bytes a dossier holds: 4 MiB. */
export const DOSSIER_LIMIT = 4 * 1024 * 1024;
/** The most images a dossier holds. */
export const IMAGE_LIMIT = 8;
/** A plain file's name: a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them, no directory. */
export const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** A dashboard file whose contents the dossier's text shows: source, never an image. */
export const SOURCE_EXT = /\.(?:html|css|js|json|mjs|svg|md|txt)$/;

/** What makeDossier is held to: the text's cap in UTF-8 bytes, and, when given, the screenshot and dashboard caps, which only refuse. */
export interface DossierLimits {
  textCap: number;
  shots?: { count: number; bytes: number };
  files?: { count: number; bytes: number };
}

/** Why makeDossier writes no dossier for a directory: its caps, its screenshots, its dashboard or its size. */
export class DossierFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierError';
  }
}

// ---------------------------------------------------------------- bytes

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_BYTES = [0xff, 0xd8, 0xff];

function startsWithBytes(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * A regular file's bytes when it is at most `cap` long; never through a link, never more than `cap`
 * bytes read. A link, a directory or a missing file is a DossierFailure with `what`.
 */
function readUpTo(path: string, cap: number, what: string): Uint8Array {
  let size: number;
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new DossierFailure('buildDossier: ' + what + ' is not a regular file');
    size = info.size;
  } catch (err) {
    if (err instanceof DossierFailure) throw err;
    throw new DossierFailure('buildDossier: ' + what + ' cannot be read');
  }
  if (size > cap) {
    throw new DossierFailure('buildDossier: ' + what + ' is ' + size + ' bytes, over the ' + cap + ' a dossier reads');
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DossierFailure('buildDossier: ' + what + ' is not a regular file');
  }
  try {
    const current = fstatSync(fd).size;
    if (current > cap) {
      throw new DossierFailure('buildDossier: ' + what + ' is ' + current + ' bytes, over the ' + cap + ' a dossier reads');
    }
    const buf = Buffer.alloc(current);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, at);
  } finally {
    closeSync(fd);
  }
}

/** Lines of a text: 0 when empty, else its newlines plus one for a last line with none. */
function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) {
    if (b === 0x0a) n++;
  }
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** A Markdown fence one backtick longer than the longest run in `body`, three at least. */
function fenceFor(body: string): string {
  let longest = 0;
  const runs = body.match(/`+/g) ?? [];
  for (const run of runs) {
    if (run.length > longest) longest = run.length;
  }
  const needed = longest + 1;
  return '`'.repeat(needed < 3 ? 3 : needed);
}

/** The fence a file's extension is shown with. */
function fenceLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return ext === 'mjs' ? 'js' : ext;
}

/**
 * JSON with every object's keys in code-unit order and no whitespace: one spelling per value. Takes
 * null, booleans, finite numbers, strings, arrays and plain objects; throws TypeError on anything else
 * (undefined, a function, a bigint, NaN, Infinity, a class instance).
 */
export function dossierJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: ' + value + ' is not a finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => dossierJson(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareText);
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + dossierJson(obj[k])).join(',') + '}';
  }
  throw new TypeError('canonicalJson: a ' + typeof value + ' has no JSON form');
}

// ---------------------------------------------------------------- the dashboard walk

/** One file of the dashboard tree: its path relative to the directory, and its size in bytes. */
interface DashboardEntry {
  path: string;
  size: number;
}

/**
 * Every regular file under `root` (symbolic links are neither followed nor taken for files), in path
 * order, with its size. Refuses a dot-directory, a file whose name a dossier refuses, an entry that is
 * neither a file nor a directory, and, when the caps are given, too many files or bytes in all.
 */
function walkDashboard(root: string, caps: { count: number; bytes: number } | null): DashboardEntry[] {
  let info: import('node:fs').Stats;
  try {
    info = lstatSync(root);
  } catch {
    throw new DossierFailure('buildDossier: no dashboard/ directory: the page and its source are what the judge reads');
  }
  if (!info.isDirectory()) throw new DossierFailure('buildDossier: dashboard is not a directory');
  const found: DashboardEntry[] = [];
  let totalBytes = 0;
  const visit = (rel: string): void => {
    const dir = rel === '' ? root : join(root, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) throw new DossierFailure('buildDossier: dashboard/' + p + ' is a dot-directory');
        visit(p);
      } else if (entry.isFile()) {
        if (!NAME_PATTERN.test(entry.name)) {
          throw new DossierFailure("buildDossier: dashboard/" + p + ": a file's name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -");
        }
        const size = lstatSync(join(root, p)).size;
        found.push({ path: p, size });
        totalBytes += size;
        if (caps !== null && found.length > caps.count) {
          throw new DossierFailure('buildDossier: dashboard/ holds more than the ' + caps.count + ' files it may');
        }
        if (caps !== null && totalBytes > caps.bytes) {
          throw new DossierFailure("buildDossier: dashboard/'s files come to more than the " + caps.bytes + ' bytes they may');
        }
      } else {
        throw new DossierFailure('buildDossier: dashboard/' + p + ' is neither a file nor a directory');
      }
    }
  };
  visit('');
  found.sort((a, b) => compareText(a.path, b.path));
  return found;
}

// ---------------------------------------------------------------- the dossier

/** A shown file as the dossier shows it. */
interface ShownSource {
  bytes: Uint8Array;
  text: string;
  fence: string;
  /** The language the fence opens with (the file's extension, mjs as js). */
  lang: string;
  /** The fenced block: the fence and the language, the text (a last LF added when it lacks one), the fence, a blank line. */
  block: string;
  blockBytes: number;
  lines: number;
}

/**
 * A file's section cut inside its contents: its heading, its first k lines in its fence (closed), a line
 * naming how many of its lines are not shown, then `tail(hidden)` (the cut line, given the bytes this
 * file leaves out), k the most lines (at least one, fewer than all) whose whole fits in `room` UTF-8
 * bytes; null when not one line fits. It cuts only after a line's LF, which is never inside a UTF-8
 * sequence nor a replacement character's bytes, so no character is split, and a line's shown bytes are
 * those of its text.
 */
function cutHead(heading: string, code: ShownSource, room: number, tail: (hidden: number) => string): string | null {
  const total = code.lines;
  const lines = code.text.split('\n');
  const open = code.fence + code.lang + '\n';
  const close = code.fence + '\n\n';
  const note = (k: number): string => '[' + (total - k) + " of this file's " + total + ' lines not shown.]\n';
  const fixed = utf8Length(heading) + utf8Length(open) + utf8Length(close);
  let best = 0;
  let shown = 0;
  let raw = 0;
  for (let k = 1; k < total; k++) {
    shown += utf8Length(lines[k - 1]!) + 1;
    raw = code.bytes.indexOf(0x0a, raw) + 1;
    if (fixed + shown + utf8Length(note(k)) + utf8Length(tail(code.bytes.length - raw)) <= room) best = k;
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = code.bytes.indexOf(0x0a, rawEnd) + 1;
  const head = lines.slice(0, best).map((l) => l + '\n').join('');
  return heading + open + head + close + note(best) + tail(code.bytes.length - rawEnd);
}

/**
 * The dossier (makefun/dossier/v1) of a dashboard directory, as canonical JSON
 * bytes: `dir/screenshots/`'s PNG and JPEG files (names starting with '.' skipped) are its images, the
 * first the cover; its text is the "## Dashboard" block and the "## Source" sections described above,
 * capped at `limits.textCap` UTF-8 bytes with the cut rule above. Throws DossierFailure on caps it
 * cannot keep and on a dashboard or screenshots directory it refuses (see the header).
 */
export function makeDossier(dir: string, limits: DossierLimits): Uint8Array {
  const max = limits.textCap;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new DossierFailure('buildDossier: caps.text_max_bytes must be a positive integer, not ' + String(max));
  }

  let imageCap = { n: IMAGE_LIMIT, whose: 'a dossier holds' };
  let imageByteCap = { n: DOSSIER_LIMIT, whose: 'a dossier holds' };
  if (limits.shots !== undefined) {
    const s = limits.shots as { count?: unknown; bytes?: unknown } | null;
    if (typeof s !== 'object' || s === null) throw new DossierFailure('buildDossier: caps.screenshots must be an object {max, max_bytes}');
    for (const k of ['count', 'bytes'] as const) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
        const keyName = k === 'count' ? 'max' : 'max_bytes';
        throw new DossierFailure('buildDossier: caps.screenshots.' + keyName + ' must be a positive integer, not ' + String(v));
      }
    }
    if ((s.count as number) < imageCap.n) imageCap = { n: s.count as number, whose: 'caps.screenshots.max allows' };
    if ((s.bytes as number) < imageByteCap.n) imageByteCap = { n: s.bytes as number, whose: 'caps.screenshots.max_bytes allows' };
  }
  let dashboardCap: { count: number; bytes: number } | null = null;
  if (limits.files !== undefined) {
    const d = limits.files as { count?: unknown; bytes?: unknown } | null;
    if (typeof d !== 'object' || d === null) throw new DossierFailure('buildDossier: caps.dashboard must be an object {max_files, max_bytes}');
    for (const k of ['count', 'bytes'] as const) {
      const v = d[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
        const keyName = k === 'count' ? 'max_files' : 'max_bytes';
        throw new DossierFailure('buildDossier: caps.dashboard.' + keyName + ' must be a positive integer, not ' + String(v));
      }
    }
    dashboardCap = { count: d.count as number, bytes: d.bytes as number };
  }

  const files = walkDashboard(join(dir, 'dashboard'), dashboardCap);

  const shotsDir = join(dir, 'screenshots');
  let shotNames: string[];
  try {
    shotNames = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(compareText);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new DossierFailure('buildDossier: no screenshots/ directory: the first screenshot is the cover');
    }
    throw new DossierFailure('buildDossier: screenshots/ cannot be read');
  }
  if (shotNames.length === 0) throw new DossierFailure('buildDossier: screenshots/ holds no image: the first is the cover');
  if (shotNames.length > imageCap.n) {
    throw new DossierFailure('buildDossier: screenshots/ holds ' + shotNames.length + ' files, over the ' + imageCap.n + ' ' + imageCap.whose);
  }
  const images = shotNames.map((name) => {
    if (!NAME_PATTERN.test(name)) {
      throw new DossierFailure("buildDossier: screenshots/" + name + ": a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -");
    }
    const bytes = readUpTo(join(shotsDir, name), imageByteCap.n, 'screenshots/' + name);
    const mediaType = startsWithBytes(bytes, PNG_BYTES) ? 'image/png' : startsWithBytes(bytes, JPEG_BYTES) ? 'image/jpeg' : null;
    if (mediaType === null) throw new DossierFailure('buildDossier: screenshots/' + name + ' is neither a PNG nor a JPEG');
    return { name, media_type: mediaType, sha256: hashHex(bytes), base64: Buffer.from(bytes).toString('base64') };
  });

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const headLines = [
    '## Dashboard',
    '',
    'Files: ' + files.length + ' (' + totalBytes + ' bytes)',
    ...files.map((f) => '- ' + f.path + ' (' + f.size + ' bytes)'),
    '',
    '## Source',
    '',
    '',
  ];
  const head = headLines.join('\n');

  // The files whose contents are shown, by path; a binary file is named in the Dashboard block only.
  const shown = files.filter((f) => SOURCE_EXT.test(f.path));
  interface Section {
    heading: string;
    code: ShownSource | null;
    size: number;
    bytes: number;
  }
  const sections: Section[] = shown.map((f) => {
    const bytes = readUpTo(join(dir, 'dashboard', f.path), DOSSIER_LIMIT, 'dashboard/' + f.path);
    const lines = countLines(bytes);
    const heading = '### ' + f.path + '\n\n' + bytes.length + ' bytes, ' + lines + ' line' + (lines === 1 ? '' : 's') + '\n\n';
    if (bytes.length === 0) return { heading, code: null, size: utf8Length(heading), bytes: 0 };
    const text = new TextDecoder('utf-8').decode(bytes);
    const fence = fenceFor(text);
    const lang = fenceLanguage(f.path);
    const block = fence + lang + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence + '\n\n';
    return { heading, code: { bytes, text, fence, lang, block, blockBytes: utf8Length(block), lines }, size: utf8Length(heading) + utf8Length(block), bytes: bytes.length };
  });

  // restBytes[k]: the bytes of the shown files after section k.
  const restBytes = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) {
    restBytes[k] = restBytes[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);
  }

  const cutLine = (count: number, bytes: number): string =>
    '[Cut at ' + max + ' bytes: ' + count + ' file' + (count === 1 ? '' : 's') + ' and ' + bytes + ' bytes left out.]\n';
  let out = head;
  let used = utf8Length(head);
  if (used + utf8Length(cutLine(0, 0)) > max) {
    throw new DossierFailure('buildDossier: caps.text_max_bytes ' + max + ' cannot hold even the Dashboard block and the cut line');
  }
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : utf8Length(cutLine(restCount, restBytes[kept]!));
    if (used + section.size + tail > max) break;
    out += section.code === null ? section.heading : section.heading + section.code.block;
    used += section.size;
  }
  if (kept < sections.length) {
    // The first file that does not fit whole: its head, up to its last complete line that fits, then nothing more.
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = restBytes[kept]!;
    const part = first.code === null ? null : cutHead(first.heading, first.code, max - used, (hidden) => cutLine(restCount, after + hidden));
    out += part ?? cutLine(restCount + 1, after + first.bytes);
  }
  if (utf8Length(out) > max) {
    throw new DossierFailure('buildDossier: caps.text_max_bytes ' + max + ' cannot hold even the Dashboard block and the cut line');
  }

  const doc = { schema: DOSSIER_ID, cover: 0, text: out.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(dossierJson(doc), 'utf8');
  if (bytes.length > DOSSIER_LIMIT) {
    throw new DossierFailure('buildDossier: the dossier is ' + bytes.length + ' bytes, over the ' + DOSSIER_LIMIT + ' one holds');
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

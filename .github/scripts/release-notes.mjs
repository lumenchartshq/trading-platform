#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section for one version, for the GitHub release
 * notes. A section starts at a `## <version>` heading (optionally `## [<version>]`
 * or followed by a date) and ends at the next `## ` heading.
 *
 * Usage: node .github/scripts/release-notes.mjs <version> [CHANGELOG.md]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEADING = /^##\s+\[?v?([^\]\s]+)\]?(?:\s|$)/;

/** The notes for `version`, or `null` when the changelog has no non-empty section for it. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => HEADING.exec(line)?.[1] === version);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.startsWith('## '));
  const notes = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return notes || null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version) {
    console.error('Usage: release-notes.mjs <version> [CHANGELOG.md]');
    process.exit(2);
  }
  const notes = releaseNotes(readFileSync(file, 'utf8'), version);
  if (!notes) {
    console.error(`${file} has no notes for ${version}. Add a "## ${version}" section.`);
    process.exit(1);
  }
  console.log(notes);
}

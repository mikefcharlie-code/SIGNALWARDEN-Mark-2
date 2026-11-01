// Generate notices from the installed, lockfile-resolved packages. No network reads.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const selected = ['@turf/boolean-intersects', '@turf/distance', '@turf/helpers', 'uplot'];
const packages = new Map();
function visit(name, resolver) {
  let directory;
  try { directory = dirname(resolver.resolve(`${name}/package.json`)); }
  catch {
    directory = dirname(resolver.resolve(name));
    while (!existsSync(join(directory, 'package.json'))) {
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate package: ${name}`);
      directory = parent;
    }
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const id = `${manifest.name}@${manifest.version}`;
  if (packages.has(id)) return;
  const licenseFiles = readdirSync(directory).filter(file => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file)).sort();
  if (!licenseFiles.length) throw new Error(`Missing license text: ${id}`);
  packages.set(id, { manifest, directory, licenseFiles });
  const nested = createRequire(join(directory, 'package.json'));
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) visit(dependency, nested);
}
for (const name of selected) visit(name, require);
let notices = '# Offline spatial analysis and telemetry chart software notices\n\n';
notices += 'Selected direct packages and their lockfile-resolved dependency closure, including type declarations.\n';
notices += 'Generated locally with: node scripts/library-notices.mjs\n';
notices += 'These software licenses do not grant rights to provider data, tiles, imagery, models or imported packs.\n';
notices += 'Existing three.js and satellite.js notices remain in worldview-software-notices.txt.\n\n';
for (const [id, { manifest, directory, licenseFiles }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  notices += `## ${id}\nLicense: ${manifest.license ?? 'See license text'}\n`;
  if (repository) notices += `Source: ${repository}\n`;
  for (const file of licenseFiles) notices += `\n--- ${file} ---\n${readFileSync(join(directory, file), 'utf8').trim()}\n`;
  notices += '\n';
}
// Preserve all license wording while making mixed upstream CRLF/spacing POSIX-safe.
notices = notices.replace(/\r\n?/g, '\n').replace(/[\t ]+$/gm, '').trimEnd() + '\n';
const destination = join(root, 'public/offline-library-notices.txt');
if (process.argv.includes('--check')) {
  if (!existsSync(destination) || readFileSync(destination, 'utf8') !== notices) throw new Error('Library notices differ; run node scripts/library-notices.mjs');
  process.stdout.write(`Verified notices for ${packages.size} packages.\n`);
} else {
  writeFileSync(destination, notices);
  process.stdout.write(`Wrote notices for ${packages.size} packages.\n`);
}

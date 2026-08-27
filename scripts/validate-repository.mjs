import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marketplacePath = join(repositoryRoot, '.agents', 'plugins', 'marketplace.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function insideRepository(path) {
  const child = resolve(path);
  return child === repositoryRoot || child.startsWith(`${repositoryRoot}${sep}`);
}

async function validatePlugin(entry) {
  assert(entry?.name && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(entry.name), 'Invalid plugin name.');
  assert(entry.source?.source === 'local', `${entry.name}: repository entries must use a local source.`);
  assert(typeof entry.source.path === 'string' && entry.source.path.startsWith('./'), `${entry.name}: source.path must start with ./`);
  assert(!isAbsolute(entry.source.path), `${entry.name}: source.path must be relative.`);
  assert(entry.policy?.installation === 'AVAILABLE', `${entry.name}: installation policy must be AVAILABLE.`);
  assert(entry.policy?.authentication === 'ON_INSTALL', `${entry.name}: authentication policy must be ON_INSTALL.`);
  assert(typeof entry.category === 'string' && entry.category.length > 0, `${entry.name}: category is required.`);

  const pluginRoot = resolve(repositoryRoot, entry.source.path);
  assert(insideRepository(pluginRoot), `${entry.name}: source.path escapes the repository.`);
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = await readJson(manifestPath);
  assert(manifest.name === entry.name, `${entry.name}: manifest and marketplace names differ.`);
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version), `${entry.name}: version is not valid semver.`);
  assert(typeof manifest.description === 'string' && manifest.description.length > 0, `${entry.name}: description is required.`);
  assert(typeof manifest.author?.name === 'string' && manifest.author.name.length > 0, `${entry.name}: author.name is required.`);
  assert(typeof manifest.interface?.displayName === 'string', `${entry.name}: interface.displayName is required.`);
  assert(manifest.skills === './skills/', `${entry.name}: expected skills at ./skills/.`);
  const skillPath = join(pluginRoot, 'skills', entry.name, 'SKILL.md');
  const skillText = await readFile(skillPath, 'utf8');
  const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
  assert(frontmatter, `${entry.name}: SKILL.md requires YAML frontmatter.`);
  const skillMetadata = Object.fromEntries(frontmatter.split(/\r?\n/u).map((line) => {
    const separator = line.indexOf(':');
    return separator < 0 ? [line.trim(), ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  assert(skillMetadata.name === entry.name, `${entry.name}: skill and plugin names differ.`);
  assert(skillMetadata.description?.length > 0, `${entry.name}: skill description is required.`);
  assert(!skillText.includes('[TODO:'), `${entry.name}: unfinished TODO placeholder in SKILL.md.`);
  for (const entrypoint of ['scripts/launcher.mjs', 'scripts/launcher.ps1', 'scripts/launcher.sh', 'scripts/stop.mjs', 'scripts/stop.ps1', 'scripts/stop.sh']) {
    await access(join(pluginRoot, entrypoint));
  }
  for (const assetField of ['composerIcon', 'logo', 'logoDark']) {
    const asset = manifest.interface?.[assetField];
    if (asset) await access(resolve(pluginRoot, asset));
  }
  process.stdout.write(`validated ${entry.name} ${manifest.version} (${relative(repositoryRoot, pluginRoot)})\n`);
}

const marketplace = await readJson(marketplacePath);
assert(/^[A-Za-z0-9_-]+$/u.test(marketplace.name), 'Invalid marketplace name.');
assert(typeof marketplace.interface?.displayName === 'string', 'Marketplace interface.displayName is required.');
assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'Marketplace must contain at least one plugin.');
for (const entry of marketplace.plugins) await validatePlugin(entry);
process.stdout.write(`validated marketplace ${marketplace.name}\n`);

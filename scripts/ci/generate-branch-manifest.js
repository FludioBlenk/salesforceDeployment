#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

function run(command) {
  return cp.execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function toOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(`${name}=${value}`);
    return;
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getApiVersion() {
  const sfdxProjectPath = path.join(process.cwd(), 'sfdx-project.json');
  const raw = fs.readFileSync(sfdxProjectPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.sourceApiVersion || '66.0';
}

function createEmptyManifest(manifestPath) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <version>${getApiVersion()}</version>\n</Package>\n`;
  fs.writeFileSync(manifestPath, xml, 'utf8');
}

function changedSourcePaths(baseRef, headRef) {
  const output = run(`git diff --name-only ${baseRef}...${headRef}`);
  if (!output) {
    return [];
  }

  const files = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => file.startsWith('force-app/'));

  const normalized = new Set();
  for (const file of files) {
    const parts = file.split('/');
    const markerIndex = parts.findIndex((p) => p === 'lwc' || p === 'aura' || p === 'objects');
    if (markerIndex > -1 && parts.length > markerIndex + 1) {
      normalized.add(parts.slice(0, markerIndex + 2).join('/'));
      continue;
    }
    normalized.add(file);
  }

  return Array.from(normalized);
}

function safeManifestName(branchName) {
  return branchName.replace(/[^a-zA-Z0-9-_]/g, '-');
}

function generateManifest(sourcePaths, outputPath, branchName) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-manifest-'));
  const manifestName = safeManifestName(branchName);

  const args = sourcePaths.map((sourcePath) => `--source-dir \"${sourcePath}\"`).join(' ');
  run(`sf project generate manifest --name ${manifestName} --output-dir \"${tempDir}\" ${args}`);

  const generatedPath = path.join(tempDir, `${manifestName}.xml`);
  fs.copyFileSync(generatedPath, outputPath);
}

function main() {
  const args = parseArgs(process.argv);
  const base = args.base;
  const head = args.head || 'HEAD';
  const branch = args.branch || 'feature';
  const output = args.output;

  if (!base || !output) {
    throw new Error('Usage: generate-branch-manifest.js --base <ref> --head <ref> --branch <name> --output <path>');
  }

  const outputPath = path.resolve(process.cwd(), output);
  ensureDir(path.dirname(outputPath));

  const sourcePaths = changedSourcePaths(base, head);
  if (!sourcePaths.length) {
    createEmptyManifest(outputPath);
    toOutput('isEmpty', 'true');
    toOutput('manifestPath', output);
    return;
  }

  generateManifest(sourcePaths, outputPath, branch);
  toOutput('isEmpty', 'false');
  toOutput('manifestPath', output);
}

main();

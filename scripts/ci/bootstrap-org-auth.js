#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const cp = require('node:child_process');

function run(command, options = {}) {
  return cp.execSync(command, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function runMaybe(command) {
  try {
    return { ok: true, out: run(command) };
  } catch (error) {
    return { ok: false, error };
  }
}

function loadConfig() {
  const configPath = path.join(process.cwd(), 'config', 'branch-environments.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function buildTargets(config) {
  const targets = [];
  const envs = config.environments || {};

  for (const [branch, env] of Object.entries(envs)) {
    targets.push({
      key: branch,
      branch,
      displayName: env.name || branch,
      authSecret: env.authSecret,
      type: 'sandbox',
    });
  }

  const prod = config.production || {};
  if (prod.sourceBranch && prod.authSecret) {
    targets.push({
      key: prod.sourceBranch,
      branch: prod.sourceBranch,
      displayName: prod.name || 'PRODUCTION',
      authSecret: prod.authSecret,
      type: 'production',
    });
  }

  return targets;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function ensureGhCli() {
  const check = runMaybe('gh --version');
  return check.ok;
}

async function main() {
  const config = loadConfig();
  const targets = buildTargets(config);

  if (!targets.length) {
    throw new Error('No deployment targets found in config/branch-environments.json');
  }

  console.log('Select the pipeline environment to authenticate:');
  targets.forEach((target, index) => {
    console.log(`  ${index + 1}. ${target.branch} (${target.displayName}) -> secret ${target.authSecret}`);
  });

  const selectionInput = await prompt('Enter number: ');
  const selection = Number(selectionInput);

  if (!Number.isInteger(selection) || selection < 1 || selection > targets.length) {
    throw new Error('Invalid selection.');
  }

  const selected = targets[selection - 1];
  const instanceUrl = await prompt('Org login URL (press Enter for Salesforce default): ');

  const alias = `auth-bootstrap-${selected.branch.replace(/[^a-zA-Z0-9-_]/g, '-')}`;

  const loginParts = ['sf org login web', `--alias ${alias}`];
  if (instanceUrl) {
    loginParts.push(`--instance-url "${instanceUrl}"`);
  }

  console.log('\nOpening Salesforce login in browser...');
  run(loginParts.join(' '), { stdio: 'inherit' });

  const displayRaw = run(`sf org display --target-org ${alias} --verbose --json`);
  const display = JSON.parse(displayRaw);
  const authUrl = display && display.result ? display.result.sfdxAuthUrl : '';

  if (!authUrl) {
    throw new Error('Could not read sfdxAuthUrl from sf org display output.');
  }

  if (ensureGhCli()) {
    console.log(`\nStoring auth in GitHub secret ${selected.authSecret}...`);
    run(`gh secret set ${selected.authSecret} --body "${authUrl}"`, { stdio: 'inherit' });
    console.log('Done. GitHub secret updated.');
  } else {
    console.log('\nGitHub CLI (gh) is not installed. Copy this auth URL into your repository secret manually:');
    console.log(`Secret name: ${selected.authSecret}`);
    console.log(authUrl);
  }

  console.log(`\nEnvironment mapped: ${selected.branch} (${selected.displayName})`);
  console.log('Authentication is now configured for CI/CD runs using this environment secret.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

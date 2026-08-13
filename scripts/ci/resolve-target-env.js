#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function toOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(`${name}=${value}`);
    return;
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

function getConfig() {
  const configPath = path.join(process.cwd(), 'config', 'branch-environments.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function normalizeBranch(rawBranch) {
  return (rawBranch || '').replace(/^refs\/heads\//, '');
}

function main() {
  const config = getConfig();
  const mode = process.argv[2];
  const branchArg = process.argv[3];
  const branch = normalizeBranch(branchArg || process.env.GITHUB_REF || '');

  if (!mode || !branch) {
    throw new Error('Usage: resolve-target-env.js <sandbox|production> <branch>');
  }

  if (mode === 'sandbox') {
    const env = config.environments[branch];
    if (!env) {
      toOutput('isDeployable', 'false');
      return;
    }

    toOutput('isDeployable', 'true');
    toOutput('branch', branch);
    toOutput('envName', env.name);
    toOutput('authSecret', env.authSecret);
    toOutput('testLevel', env.testLevel || 'RunLocalTests');
    return;
  }

  if (mode === 'production') {
    const prod = config.production || {};
    const isSourceBranch = branch === prod.sourceBranch;
    toOutput('isDeployable', String(Boolean(isSourceBranch)));
    toOutput('sourceBranch', prod.sourceBranch || 'master');
    toOutput('trackingBranch', prod.trackingBranch || 'production');
    toOutput('envName', prod.name || 'PRODUCTION');
    toOutput('authSecret', prod.authSecret || 'SF_AUTH_URL_PROD');
    toOutput('testLevel', prod.testLevel || 'RunLocalTests');
    return;
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

main();

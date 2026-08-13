# Salesforce GitHub Deployment Flow

This repository is configured for branch-driven Salesforce deployments with GitHub Actions.

## Deployment Pipeline Overview

```mermaid
flowchart TD
    DEV_PUSH["Push to\nfeature/**"]
    MANIFEST["sf-manifest-feature.yml\nGenerate delta manifest\nmanifest/branches/*.xml"]
    PR_OPEN["Developer opens PR\nfeature → develop"]
    PR_VAL_DEV["sf-validate-pr.yml\nCheck-only deploy (dry-run)\nDelta manifest → DEV sandbox"]
    PR_FAIL_DEV["❌ Validation Fails\nPR blocked — fix and re-push"]
    PR_PASS_DEV["✅ Validation Passes\nMerge allowed"]

    MERGE_DEV["Merge into develop"]
    DEPLOY_DEV["sf-deploy-sandbox.yml\nDeploy force-app/ → DEV sandbox\nRunLocalTests"]
    REVERT_DEV["revert-on-failure\nAuto-revert commit [skip ci]\npushed to develop"]
    SUCCESS_DEV["✅ DEV deploy success"]
    AUTO_PR_UAT["🤖 GitHub Actions\nAuto-opens PR: develop → uat"]

    PR_VAL_UAT["sf-validate-pr.yml\nCheck-only deploy (dry-run)\nDelta manifest → UAT sandbox"]
    PR_FAIL_UAT["❌ Validation Fails\nPR blocked"]
    PR_PASS_UAT["✅ Validation Passes\nMerge allowed"]
    MERGE_UAT["Merge into uat"]
    DEPLOY_UAT["sf-deploy-sandbox.yml\nDeploy force-app/ → UAT sandbox\nRunLocalTests"]
    REVERT_UAT["revert-on-failure\nAuto-revert commit [skip ci]\npushed to uat"]
    SUCCESS_UAT["✅ UAT deploy success"]
    AUTO_PR_PROD["🤖 GitHub Actions\nAuto-opens PR: uat → master"]

    PR_VAL_PROD["sf-validate-pr.yml\nCheck-only deploy (dry-run)\nDelta manifest → Production"]
    PR_FAIL_PROD["❌ Validation Fails\nPR blocked"]
    PR_PASS_PROD["✅ Validation Passes\nMerge allowed"]
    MERGE_PROD["Merge into master"]
    DEPLOY_PROD["sf-deploy-production-from-master.yml\nDeploy force-app/ → Production\nRunLocalTests"]
    REVERT_PROD["revert-on-failure\nAuto-revert commit [skip ci]\npushed to master"]
    SUCCESS_PROD["✅ Production deploy success\nproduction tracking branch updated"]

    HUMAN["👤 Human approval\nrequired to merge"]
    CONFIG["config/branch-environments.json\npromotionTarget controls the chain\nAdd/remove envs — no workflow changes"]

    DEV_PUSH --> MANIFEST
    DEV_PUSH --> PR_OPEN
    PR_OPEN --> PR_VAL_DEV
    PR_VAL_DEV --> PR_FAIL_DEV
    PR_VAL_DEV --> PR_PASS_DEV
    PR_PASS_DEV --> MERGE_DEV

    MERGE_DEV --> DEPLOY_DEV
    DEPLOY_DEV -- "failure" --> REVERT_DEV
    DEPLOY_DEV -- "success" --> SUCCESS_DEV
    SUCCESS_DEV --> AUTO_PR_UAT

    AUTO_PR_UAT --> HUMAN
    HUMAN --> PR_VAL_UAT
    PR_VAL_UAT --> PR_FAIL_UAT
    PR_VAL_UAT --> PR_PASS_UAT
    PR_PASS_UAT --> MERGE_UAT

    MERGE_UAT --> DEPLOY_UAT
    DEPLOY_UAT -- "failure" --> REVERT_UAT
    DEPLOY_UAT -- "success" --> SUCCESS_UAT
    SUCCESS_UAT --> AUTO_PR_PROD

    AUTO_PR_PROD --> HUMAN
    HUMAN --> PR_VAL_PROD
    PR_VAL_PROD --> PR_FAIL_PROD
    PR_VAL_PROD --> PR_PASS_PROD
    PR_PASS_PROD --> MERGE_PROD

    MERGE_PROD --> DEPLOY_PROD
    DEPLOY_PROD -- "failure" --> REVERT_PROD
    DEPLOY_PROD -- "success" --> SUCCESS_PROD

    CONFIG -. "promotionTarget chain" .-> AUTO_PR_UAT
    CONFIG -. "promotionTarget chain" .-> AUTO_PR_PROD
```

## Branching Model

Each sandbox environment has its own branch.

Example:

- `develop` -> DEV sandbox
- `uat` -> UAT sandbox
- `master` -> production deployment source branch
- `production` -> production tracking branch (updated only after successful prod deploy)

Feature workflow:

1. Create feature branch from the source sandbox branch, for example `feature/my-change` from `develop`.
2. Push feature changes. A branch manifest is generated automatically at `manifest/branches/<feature-name>.package.xml`.
3. Open a PR from the feature branch to a target sandbox branch (for example `uat`).
4. PR validation runs a check-only deployment to the target sandbox.
5. If validation succeeds, merge PR.
6. Merge push triggers deployment to that sandbox branch environment.

Production workflow:

1. Push or merge approved changes into `master`.
2. Production workflow deploys from `master` to Production org.
3. If deployment succeeds, workflow updates `production` branch to the deployed commit.

## Configuration

Edit [config/branch-environments.json](config/branch-environments.json).

Fields:

- `defaultFeatureBaseBranch`: branch used to compute feature branch manifest delta.
- `environments`: map of branch name to sandbox deployment target.
	- `name`: label for environment.
	- `authSecret`: GitHub secret name containing SFDX auth URL.
	- `testLevel`: Salesforce test level for deploy/validate.
- `production`: production deployment settings.
	- `sourceBranch`: branch that triggers production deploy (default `master`).
	- `trackingBranch`: branch updated after successful production deploy (default `production`).
	- `authSecret`: GitHub secret name for production auth URL.

## Required GitHub Secrets

Create these repository secrets (or rename in config):

- `SF_AUTH_URL_DEV`
- `SF_AUTH_URL_UAT`
- `SF_AUTH_URL_PROD`

Each value must be an SFDX auth URL for the corresponding org.

## One-Time Interactive Org Authentication Setup

If you want to type an org login URL, sign in as yourself in the browser, and assign that auth to a specific pipeline environment, use:

`npm run auth:bootstrap`

What it does:

1. Reads targets from `config/branch-environments.json`.
2. Prompts you to pick the environment branch (`develop`, `uat`, `master`, etc.).
3. Prompts for org login URL (for example `https://test.salesforce.com` or your My Domain URL).
4. Runs `sf org login web` and opens browser login.
5. Extracts `sfdxAuthUrl` from the authenticated org.
6. Stores the value into the mapped GitHub secret (for example `SF_AUTH_URL_DEV`) using `gh secret set`.

Notes:

- This browser-based login must be run locally (GitHub-hosted runners cannot do interactive browser redirects).
- You only need to repeat this when the auth URL is rotated/revoked/expired.
- CI/CD workflows then use the stored secret automatically on every deployment.

## Workflows Added

- [Salesforce Feature Manifest](.github/workflows/sf-manifest-feature.yml)
	- Trigger: push to `feature/**`
	- Output: branch-specific manifest in `manifest/branches/`
- [Salesforce PR Validation](.github/workflows/sf-validate-pr.yml)
	- Trigger: pull requests
	- Behavior: check-only deploy to org mapped from PR base branch
- [Salesforce Sandbox Deployment](.github/workflows/sf-deploy-sandbox.yml)
	- Trigger: push/merge to any branch
	- Behavior: deploys only if branch exists in `environments`; **auto-reverts on failure**
- [Salesforce Production Deployment](.github/workflows/sf-deploy-production-from-master.yml)
	- Trigger: push/merge to `master`
	- Behavior: deploy to prod, update production tracking branch; **auto-reverts on failure**
- [Salesforce Org Auth Check](.github/workflows/sf-auth-org.yml)
    - Trigger: manual (`workflow_dispatch`)
    - Behavior: resolves target org from config, authenticates with mapped secret, prints org session details

## Manual Org Authentication Workflow

Use [sf-auth-org.yml](.github/workflows/sf-auth-org.yml) when you want to verify org authentication independently of deployments.

How to run:

1. Open **GitHub → Actions → Salesforce Org Auth Check → Run workflow**.
2. Choose `mode`:
    - `sandbox`: resolves from `environments` in `config/branch-environments.json`.
    - `production`: resolves from `production` in `config/branch-environments.json`.
3. Enter `branch`:
    - examples: `develop`, `uat`, `master`
4. Run workflow.

Expected behavior:

- If mapping exists and secret is configured, authentication succeeds and `sf org display --verbose` is shown in logs.
- If mapping is missing, workflow fails with a clear message.
- If secret is missing/empty, workflow fails with a clear message.

## Auto-Revert on Deployment Failure

When a merge into an environment branch (e.g. `develop`, `uat`, `master`) triggers a deployment that **fails**, the pipeline automatically pushes a revert commit back to that branch. The revert commit message includes `[skip ci]` so it does not trigger another deploy run.

This keeps the environment branch in a deployable state at all times. Developers must fix the issue on the feature branch and open a new PR.

### How the revert works

1. PR is merged into `develop` → push event fires → `sf-deploy-sandbox.yml` runs.
2. `sf project deploy start` fails (test failure, validation error, etc.).
3. `revert-on-failure` job runs.
4. It detects whether HEAD is a merge commit or a squash commit and runs the appropriate `git revert`.
5. Pushes `revert: auto-rollback — deployment to DEV_SANDBOX failed [skip ci]` to `develop`.

### Branch Protection Requirements for Auto-Revert

The revert job pushes directly to the protected environment branch using the `GITHUB_TOKEN`. For this to succeed you **must** configure branch protection on each environment branch:

1. Go to **Repository Settings → Branches → Branch protection rules**.
2. Select the rule for the environment branch (e.g. `develop`).
3. Under **"Allow specified actors to bypass required pull requests"**, add **GitHub Actions** (or `github-actions[bot]`).

Without this, the revert push will fail with a 403 error, and the branch will remain in the broken state until manually reverted.

## Branch Protection Recommendations

Set required checks before merge to catch failures *before* they land on an environment branch:

- Require [Salesforce PR Validation](.github/workflows/sf-validate-pr.yml) as a required status check on all environment branches (`develop`, `uat`, `master`).
- Require at least one review approval.
- Restrict direct pushes to environment branches — only merges via PRs should be allowed.
- Allow the `github-actions[bot]` to bypass push restrictions (required for auto-revert).

## Local Utility Scripts

- `npm run manifest:branch -- --base origin/develop --head HEAD --branch feature/my-change --output manifest/branches/feature-my-change.package.xml`
- `npm run ci:resolve-target -- sandbox uat`

## Notes

- Deploy workflows install Salesforce CLI dynamically in GitHub runners.
- Validation uses manifest delta; branch deployments use full source (`force-app`) for consistency.

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { releaseChangelog, releaseVersion } from 'nx/release/index.js';
import semver from 'semver';

const ROOT_DIRECTORY = new URL('../', import.meta.url);
const PACKAGE_DIRECTORIES = [ROOT_DIRECTORY];
const PACKAGE_PATHS = PACKAGE_DIRECTORIES.map((directory) => new URL('./package.json', directory));
const PROJECTS = PACKAGE_DIRECTORIES.map((directory) => {
  const projectPath = new URL('./project.json', directory);
  return existsSync(projectPath)
    ? JSON.parse(readFileSync(projectPath, 'utf8')).name
    : JSON.parse(readFileSync(new URL('./package.json', directory), 'utf8')).name;
});
const GIT_OPTIONS = { gitCommit: false, gitPush: false, gitTag: false, stageChanges: false };

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const packageVersions = () => PACKAGE_PATHS.map((path) => JSON.parse(readFileSync(path, 'utf8')).version);

const assertClean = () => {
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  assert(status.length === 0, 'release preparation requires a clean worktree');
};

export const validateRequestedVersion = ({ currentVersions, plannedVersions, requestedVersion }) => {
  assert(
    currentVersions.every((version) => semver.valid(version)),
    'invalid package version',
  );
  assert(new Set(currentVersions).size === 1, 'fixed release packages have different versions');
  assert(
    plannedVersions.every((version) => semver.valid(version)),
    'invalid Version Plan result',
  );
  assert(new Set(plannedVersions).size === 1, 'Version Plans did not produce one fixed version');
  assert(semver.valid(requestedVersion), `invalid requested version: ${requestedVersion}`);
  assert(semver.prerelease(requestedVersion) === null, 'routine releases require stable SemVer');
  assert(
    requestedVersion === plannedVersions[0],
    `requested ${requestedVersion} does not match Version Plans (${plannedVersions[0]})`,
  );
  assert(
    semver.gt(requestedVersion, currentVersions[0]),
    `${requestedVersion} must be newer than ${currentVersions[0]}`,
  );
  return requestedVersion;
};

/** The one version every pending Version Plan agrees on, for `--from-plans` runs. */
export const versionFromPlans = (plannedVersions) => {
  assert(
    plannedVersions.length > 0 && plannedVersions.every(Boolean),
    'no pending Version Plan affects the fixed release group',
  );
  assert(new Set(plannedVersions).size === 1, 'Version Plans did not produce one fixed version');
  return plannedVersions[0];
};

const prepare = async ({ dryRun, requestedVersion }) => {
  // Asserted on entry: the `preVersionCommand` quality gate can regenerate
  // committed artifacts, so the tree cannot be required clean once preparation
  // has started. Release-commit purity is enforced by the caller staging only
  // release files, and by the CI release policy.
  if (!dryRun) assertClean();

  const currentVersions = packageVersions();
  const preview = await releaseVersion({ ...GIT_OPTIONS, deleteVersionPlans: false, dryRun: true });
  const plannedVersions = PROJECTS.map((project) => preview.projectsVersionData[project]?.newVersion);
  const version = requestedVersion ?? versionFromPlans(plannedVersions);
  validateRequestedVersion({
    currentVersions,
    plannedVersions,
    requestedVersion: version,
  });

  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: true,
    dryRun: true,
    releaseGraph: preview.releaseGraph,
    version,
  });
  if (dryRun) return version;

  await releaseVersion({
    ...GIT_OPTIONS,
    deleteVersionPlans: true,
    version,
  });
  execFileSync('pnpm', ['install', '--lockfile-only'], { stdio: 'inherit' });
  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: false,
    releaseGraph: preview.releaseGraph,
    version,
  });
  assert(
    packageVersions().every((prepared) => prepared === version),
    `fixed release did not prepare every package at ${version}`,
  );
  return version;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedVersion = process.argv.slice(2).find((value) => !value.startsWith('-'));
  const dryRun = process.argv.includes('--dry-run');
  const fromPlans = process.argv.includes('--from-plans');

  try {
    assert(
      fromPlans ? !requestedVersion : requestedVersion,
      'usage: pnpm release:prepare -- <version> [--dry-run], or pnpm release:prepare -- --from-plans [--dry-run]',
    );
    const version = await prepare({ dryRun, requestedVersion });
    console.log(`${dryRun ? 'Would prepare' : 'Prepared'} libassimp v${version}`);
    if (!dryRun) {
      console.log(`Commit generated release files as: chore(release): libassimp v${version}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

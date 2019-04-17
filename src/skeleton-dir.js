import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import createResolve from '@pnpm/git-resolver';
import git from 'graceful-git';
import got from 'got';
import gunzip from 'gunzip-maybe';
import tar from 'tar-fs';

function resolveRepo(supplier) {
  return createResolve({})({pref: supplier})
    .then(
      result => result.resolution,
      err => {
        console.error(err);
      }
    );
}

function ensureTmpFolder() {
  const folder = path.join(os.tmpdir(), 'makes');
  try {
    fs.mkdirSync(folder);
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }
  return folder;
}

function generateHash(bufOrStr) {
  return crypto.createHash('md5').update(bufOrStr).digest('hex');
}

function isDir(dir) {
  try {
    const stats = fs.statSync(dir);
    return stats.isDirectory();
  } catch (e) {
    return false;
  }
}

async function useCached(folder, hash, generate) {
  const target = path.join(folder, hash);
  if (!isDir(target)) {
    await generate(target);
  }

  const files = fs.readdirSync(target);
  if (files.length === 1) {
    return path.join(target, files[0]);
  }
  return target;
}

export default async function(supplier, {
  _resolve = resolveRepo,
  _tmpFolder
} = {}) {
  // local folder
  if (supplier.startsWith('.')) {
    if (isDir(supplier)) return supplier;
    throw new Error(`Local folder "${supplier}" does not exist.`);
  }

  // for "something" or "github:something"
  // turn to "something/new" or "github:something/new"
  if (supplier.match(/^([a-zA-Z0-9-_]+:)?[a-zA-Z0-9-_]+$/)) {
    supplier += '/new';
  }

  const resolution = await _resolve(supplier);

  if (!resolution) {
    throw new Error('Cannot find git repo ' + supplier);
  }

  if (!_tmpFolder) {
    _tmpFolder = ensureTmpFolder();
  }

  if (resolution.tarball) {
    return await useCached(
      _tmpFolder,
      generateHash(resolution.tarball),
      target => {
        return new Promise((resolve, reject) => {
          got.stream(resolution.tarball)
            .pipe(gunzip())
            .pipe(tar.extract(target))
            .once('error', reject)
            .once('finish', resolve);
        });
      }
    );
  } else {
    // git
    const {type, repo, commit} = resolution;
    if (type !== 'git') {
      throw new Error('Unknown repo type: ' + type);
    }

    return await useCached(
      _tmpFolder,
      generateHash(repo + commit),
      async target => {
        await git(['clone', repo, target]);
        await git(['checkout', commit], {cwd: target});
      }
    );
  }
}

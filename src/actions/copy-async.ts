import assert from 'assert';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { globbySync, isDynamicPattern, type Options as GlobbyOptions } from 'globby';
import multimatch from 'multimatch';
import { render, globify, getCommonPath } from '../util.js';
import normalize from 'normalize-path';
import type { MemFsEditor } from '../index.js';
import { AppendOptions } from './append.js';
import { Data, Options } from 'ejs';
import { CopySingleOptions } from './copy.js';

async function applyProcessingFileFunc(
  this: MemFsEditor,
  processFile: CopySingleAsyncOptions['processFile'],
  filename: string
) {
  const output = await Promise.resolve(processFile!.call(this, filename));
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function renderFilepath(filepath: string | null, context, tplSettings) {
  if (!context || !filepath) {
    return filepath;
  }

  return render(filepath, context, tplSettings);
}

async function getOneFile(from: string | string[]) {
  let oneFile;
  if (typeof from === 'string') {
    oneFile = from;
  } else {
    return undefined;
  }

  const resolved = path.resolve(oneFile);
  try {
    if ((await fsPromises.stat(resolved)).isFile()) {
      return resolved;
    }
  } catch (_) {}

  return undefined;
}

export type CopyAsyncOptions = CopySingleAsyncOptions & {
  globOptions?: GlobbyOptions;
  processDestinationPath?: (string) => string;
  ignoreNoMatch?: boolean;
};

export async function copyAsync(
  this: MemFsEditor,
  from: string | string[],
  to: string | null,
  options?: CopyAsyncOptions,
  context?: Data,
  tplSettings?: Options
) {
  to = to ? path.resolve(to) : to;
  options = options || {};
  const oneFile = await getOneFile(from);
  if (oneFile) {
    return [await this._copySingleAsync(oneFile, renderFilepath(to, context, tplSettings), options)];
  }

  const fromGlob = globify(from);

  const globOptions = { ...options.globOptions, nodir: true };
  const diskFiles = globbySync(fromGlob, globOptions).map((filepath) => path.resolve(filepath));
  const storeFiles: string[] = [];
  this.store.each((file) => {
    // The store may have a glob path and when we try to copy it will fail because not real file
    if (
      !isDynamicPattern(normalize(file.path)) &&
      multimatch([file.path], fromGlob).length !== 0 &&
      !diskFiles.includes(file.path)
    ) {
      storeFiles.push(file.path);
    }
  });

  let generateDestination: (string) => string | null = () => to;
  if (Array.isArray(from) || !this.exists(from) || isDynamicPattern(normalize(from))) {
    assert(
      !to || !this.exists(to) || fs.statSync(to).isDirectory(),
      'When copying multiple files, provide a directory as destination'
    );

    const processDestinationPath = options.processDestinationPath || ((path) => path);
    const root = getCommonPath(from);
    generateDestination = (filepath) => {
      if (!to) return to;
      const toFile = path.relative(root, filepath);
      return processDestinationPath(path.join(to, toFile));
    };
  }

  // Sanity checks: Makes sure we copy at least one file.
  assert(
    options.ignoreNoMatch || diskFiles.length > 0 || storeFiles.length > 0,
    'Trying to copy from a source that does not exist: ' + from
  );

  const rendered = await Promise.all([
    ...diskFiles.map((file) =>
      this._copySingleAsync(file, renderFilepath(generateDestination(file), context, tplSettings), options)
    ),
    ...storeFiles.map((file) =>
      Promise.resolve(this._copySingle(file, renderFilepath(generateDestination(file), context, tplSettings), options))
    ),
  ]);
  if (rendered.find(Boolean)) {
    return rendered;
  }
}

export type CopySingleAsyncOptions = AppendOptions &
  CopySingleOptions & {
    append?: boolean;
    processFile?: (this: MemFsEditor, filepath: string) => string | Promise<string | Buffer>;
  };

export async function _copySingleAsync(
  this: MemFsEditor,
  from: string,
  to: string | null,
  options: CopySingleAsyncOptions = {}
) {
  if (!options.processFile) {
    return this._copySingle(from, to, options);
  }

  const contents = await applyProcessingFileFunc.call(this, options.processFile, from);

  if (!to) {
    return { path: from, contents };
  }

  if (options.append) {
    if (!this.store.existsInMemory) {
      throw new Error('Current mem-fs is not compatible with append');
    }

    if (this.store.existsInMemory(to)) {
      this.append(to, contents, { create: true, ...options });
      return;
    }
  }

  const stat = await fsPromises.stat(from);
  this.write(to, contents, stat);
}

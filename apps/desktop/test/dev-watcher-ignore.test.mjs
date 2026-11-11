import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.url` points at this file, so the app root is one level up.
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The dev server must not watch a directory the test suites write into.
 *
 * The suites create their scratch trees under `apps/desktop/` because they
 * need a real path on a real volume. Some of those trees hold a live Chromium
 * profile, and Chromium keeps temporary files open inside it. Vite's watcher
 * then hits `EBUSY` on such a file and emits an unhandled `error` on the
 * FSWatcher, which takes the whole dev process down with it. That is not
 * hypothetical: it killed three PI-Desktop sessions on 2026-11-10 while the
 * desktop test suites were running.
 *
 * So every scratch prefix the suites create has to be in the ignore list.
 * This test derives the prefixes from the suites themselves, so a new suite
 * cannot silently reintroduce the crash.
 */
function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) collectFiles(full, out);
    else if (/\.(mjs|ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** The `apps/desktop/.<name>-` prefixes the suites pass to `mkdtemp`. */
function scratchPrefixes() {
  const prefixes = new Set();
  for (const file of collectFiles(join(desktopRoot, "test"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/apps\/desktop\/\.([A-Za-z0-9._-]+?)-["'`]/g)) {
      prefixes.add(match[1]);
    }
  }
  return prefixes;
}

/** The glob patterns the dev server is configured to ignore. */
function ignorePatterns() {
  const config = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");
  const block = config.slice(config.indexOf("const TEST_SCRATCH_IGNORE = ["));
  const body = block.slice(0, block.indexOf("];"));
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** The subset of chokidar's glob syntax the ignore list uses. */
function toRegExp(pattern) {
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("**/", index)) {
      out += "(?:.*/)?";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      out += ".*";
      index += 2;
    } else if (pattern[index] === "*") {
      out += "[^/]*";
      index += 1;
    } else if (pattern[index] === "?") {
      out += "[^/]";
      index += 1;
    } else {
      out += pattern[index].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      index += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

test("every desktop scratch tree is ignored by the dev server watcher", () => {
  const prefixes = scratchPrefixes();
  assert.ok(prefixes.size > 0, "the suites still create scratch trees");

  const regexes = ignorePatterns().map(toRegExp);
  // A pattern that ends in `/**` covers the directory itself as well as
  // everything under it, which is how chokidar applies it.
  const ignored = (relativePath) =>
    regexes.some((regex) => regex.test(relativePath) || regex.test(`${relativePath}/`));

  for (const prefix of prefixes) {
    const directory = `apps/desktop/.${prefix}-abcdefg`;
    assert.ok(
      ignored(directory),
      `the dev server must ignore ${directory}; a suite that creates it is missing from TEST_SCRATCH_IGNORE`,
    );
    assert.ok(
      ignored(`${directory}/profile/Network/entry.tmp`),
      `the dev server must ignore files inside ${directory}`,
    );
  }
});

test("the ignore list does not cover source files", () => {
  const regexes = ignorePatterns().map(toRegExp);
  const ignored = (relativePath) =>
    regexes.some((regex) => regex.test(relativePath) || regex.test(`${relativePath}/`));

  for (const sourcePath of [
    "apps/desktop/src/main.tsx",
    "apps/desktop/electron/main/index.ts",
    "apps/desktop/electron.vite.config.ts",
    "apps/desktop/test/computer-use-settings-user-path.test.mjs",
    "packages/computer-use/src/loop.ts",
    "crates/host-core/src/computer/policy.rs",
    // A hidden, hyphenated directory is what a scratch tree looks like, but
    // it is also what a real source directory could be called. A catch-all
    // rule for that shape would silently stop watching the source directory,
    // and the dev server would serve a stale build of it.
    "apps/desktop/.internal-docs/readme.md",
    "apps/desktop/.generated-types/index.d.ts",
  ]) {
    assert.ok(!ignored(sourcePath), `the dev server must keep watching ${sourcePath}`);
  }
});

test("the repo root the test runs from is the desktop app", () => {
  assert.ok(
    relative(repoRoot, desktopRoot).includes("apps"),
    "the test must run from apps/desktop so the scratch prefixes are found",
  );
});

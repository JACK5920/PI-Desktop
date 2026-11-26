import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_BUILD_TARGETS = Object.freeze([
  {
    name: "macOS arm64",
    os: "macos-15",
    arch: "arm64",
    runner_arch: "arm64",
    artifact: "mac-arm64",
    platform: "macos",
    dist: "dist:mac",
  },
  {
    name: "macOS Intel x64",
    os: "macos-15-intel",
    arch: "x64",
    runner_arch: "x86_64",
    artifact: "mac-x64",
    platform: "macos",
    dist: "dist:mac",
  },
  {
    name: "Windows x64",
    os: "windows-latest",
    arch: "x64",
    artifact: "windows-x64",
    platform: "windows",
    dist: "dist:win",
  },
  {
    name: "Linux x64",
    os: "ubuntu-22.04",
    arch: "x64",
    runner_arch: "x86_64",
    artifact: "linux-x64",
    platform: "linux",
    feed: "latest-linux.yml",
    dist: "dist:linux",
  },
  {
    name: "Linux arm64",
    os: "ubuntu-22.04-arm",
    arch: "arm64",
    runner_arch: "aarch64",
    artifact: "linux-arm64",
    platform: "linux",
    feed: "latest-linux-arm64.yml",
    dist: "dist:linux",
  },
]);

export function createReleaseBuildMatrix(platforms = "all") {
  const selectedPlatforms = platforms || "all";
  if (selectedPlatforms !== "all" && selectedPlatforms !== "windows-linux") {
    throw new Error(`Unsupported release platform set: ${selectedPlatforms}`);
  }

  return {
    include: RELEASE_BUILD_TARGETS.filter(
      (target) => selectedPlatforms === "all" || target.platform !== "macos",
    ).map((target) => ({ ...target })),
  };
}

function writeMatrixOutput() {
  const matrix = JSON.stringify(createReleaseBuildMatrix(process.argv[2]));
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `build_matrix=${matrix}\n`, "utf8");
  } else {
    process.stdout.write(`${matrix}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  writeMatrixOutput();
}

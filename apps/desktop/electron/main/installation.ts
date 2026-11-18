import { app } from "electron";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import {
  applyDevelopmentUserData,
  desktopDataDir,
  DEVELOPMENT_BUILD_SWITCH,
  resolveDevelopmentBuild,
} from "./data-paths";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
const launchedAsDevelopment = process.argv.includes(DEVELOPMENT_BUILD_SWITCH);
if (launchedAsDevelopment) process.env.PI_DESKTOP_DEV = "1";
export const isDevelopmentBuild = resolveDevelopmentBuild({
  environmentValue: process.env.PI_DESKTOP_DEV,
  packaged: app.isPackaged,
  argv: process.argv,
});
app.setName(APP_NAME);
applyDevelopmentUserData(app, isDevelopmentBuild);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;

/**
 * Whether the environment forces the data directory, ignoring the persisted
 * storage preference. Unrelated to the instance lock below — it is passed to
 * `prepareStorage` as `overridden`.
 */
export const storageOverridden = Boolean(process.env.PI_DESKTOP_DATA_DIR);

/**
 * The lock is always taken.
 *
 * An explicit `PI_DESKTOP_DATA_DIR` used to disable it entirely, on the theory
 * that a development profile must never collide with a shipped install. That
 * reasoning only covers *different* profiles: two processes pointed at the
 * *same* directory are still one application, and letting both boot re-creates
 * the failure this guard exists to prevent. On 2026-11-10 07:09 the app booted
 * three times in 17 seconds, each instance forked its own host process for every
 * plugin, and twelve plugin hosts exited with code 1 at once — which is how a
 * bound Computer Use provider row disappeared.
 *
 * `requestSingleInstanceLock` is keyed by the `userData` path, and
 * `applyDevelopmentUserData` above already points a development build at its own
 * directory, so a dev profile and a shipped install still never collide — while
 * two processes sharing one directory now do.
 */
export const hasSingleInstanceLock = app.requestSingleInstanceLock();
export const defaultDataDir = desktopDataDir(isDevelopmentBuild);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");

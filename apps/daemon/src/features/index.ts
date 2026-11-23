/**
 * Every daemon feature, in setup order (PLAN B.10 seam 1). A feature
 * workstream fills in its own `features/<name>.ts` and never edits this file.
 */

import type { FeatureEntry } from "./types.js";
import { setupCoreCommands } from "./core-commands.js";
import { setupScrubbing } from "./scrubbing.js";
import { setupAccounts } from "./accounts.js";
import { setupApprovals } from "./approvals.js";
import { setupSandbox } from "./sandbox.js";
import { setupUndo } from "./undo.js";
import { setupLearning } from "./learning.js";
import { setupCurator } from "./curator.js";
import { setupUserModel } from "./usermodel.js";
import { setupGoals } from "./goals.js";
import { setupLoops } from "./loops.js";
import { setupHeartbeatControl } from "./heartbeat-control.js";
import { setupWebhooks } from "./webhooks.js";
import { setupSecrets } from "./secrets.js";
import { setupPlugins } from "./plugins.js";
import { setupComputerUse } from "./computer-use.js";
import { setupVoice } from "./voice.js";

export type { DaemonContext, FeatureHandle, FeatureSetup, FeatureEntry } from "./types.js";
export { runFeatureSetups, startFeatures, stopFeatures } from "./runner.js";

export const FEATURES: readonly FeatureEntry[] = [
  { name: "core-commands", setup: setupCoreCommands },
  { name: "scrubbing", setup: setupScrubbing, security: "secret scrubbing (secrets are not masked in messages, logs and cards)" },
  { name: "accounts", setup: setupAccounts },
  { name: "approvals", setup: setupApprovals, security: "the approval gate (no hardline list, deny list or ask rules)" },
  { name: "sandbox", setup: setupSandbox },
  { name: "undo", setup: setupUndo },
  { name: "learning", setup: setupLearning, security: "the skill write guard (skill files are not protected from agent writes)" },
  { name: "curator", setup: setupCurator },
  { name: "usermodel", setup: setupUserModel },
  { name: "goals", setup: setupGoals },
  { name: "loops", setup: setupLoops },
  { name: "heartbeat-control", setup: setupHeartbeatControl },
  { name: "webhooks", setup: setupWebhooks },
  { name: "secrets", setup: setupSecrets },
  { name: "plugins", setup: setupPlugins },
  { name: "computer-use", setup: setupComputerUse },
  { name: "voice", setup: setupVoice },
];

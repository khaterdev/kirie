// @kirie/daemon - Long-running gateway process
import { scrubSecrets } from "@kirie/core";
import { startDaemon } from "./lifecycle.js";
import { startupFailureLine } from "./features/scrubbing.js";

startDaemon().catch((err) => {
  // SCRUB-N5: this goes to daemon.err.log, outside the scrubbing logger. Only the
  // error's name and message, scrubbed (a grammY error URL carries the bot token).
  let line: string;
  try {
    line = startupFailureLine(err, (text) => scrubSecrets(text, { sink: "log" }));
  } catch {
    line = "Failed to start Kirie daemon (the error could not be shown safely)";
  }
  console.error(line);
  process.exit(1);
});

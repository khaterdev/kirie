// @kirie/daemon - Long-running gateway process
import { startDaemon } from "./lifecycle.js";

startDaemon().catch((err) => {
  console.error("Failed to start Kirie daemon:", err);
  process.exit(1);
});

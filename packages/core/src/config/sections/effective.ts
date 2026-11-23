import { z } from "zod/v3";
import type { RuntimeSettings } from "../runtime-settings.js";

const BooleanSetting = z.boolean();

/**
 * A boolean config value with its owner override from RuntimeSettings applied
 * (override ?? config). For callers without zod, such as the daemon.
 */
export function effectiveSettingFlag(
  settings: Pick<RuntimeSettings, "effective"> | null | undefined,
  key: string,
  configValue: boolean,
): boolean {
  return settings ? settings.effective(key, BooleanSetting, configValue) : configValue;
}

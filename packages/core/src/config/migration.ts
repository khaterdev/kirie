export interface Migration {
  version: number;
  description: string;
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
}

const migrations: Migration[] = [
  {
    version: 2,
    description: "Add config version field",
    migrate(config) {
      return { ...config, configVersion: 2 };
    },
  },
  // Future migrations go here
];

export function migrateConfig(config: Record<string, unknown>): Record<string, unknown> {
  let currentVersion = (config.configVersion as number) ?? 1;
  let result = { ...config };

  for (const migration of migrations) {
    if (currentVersion < migration.version) {
      result = migration.migrate(result);
      currentVersion = migration.version;
    }
  }

  result.configVersion = currentVersion;
  return result;
}

export function getCurrentVersion(): number {
  return migrations.length > 0 ? migrations[migrations.length - 1]!.version : 1;
}

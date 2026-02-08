export interface SkillDefinition {
  name: string;
  description: string;
  emoji?: string;
  version?: string;
  author?: string;
  os?: ("darwin" | "linux" | "win32")[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: SkillInstallSpec[];
  invocation?: {
    userInvocable?: boolean;
    disableModelInvocation?: boolean;
  };
  content: string;
  source: SkillSource;
  filePath: string;
}

export type SkillSource = "bundled" | "managed" | "workspace" | "plugin";

export interface SkillInstallSpec {
  kind: "brew" | "npm" | "go" | "pip" | "download";
  package?: string;
  formula?: string;
  module?: string;
  url?: string;
  bins?: string[];
  os?: string[];
}

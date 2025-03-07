import { TargetNames } from "./options.ts";
import type { Target, Targets, InputTargets } from "./types.ts";

export type { Target, Targets, InputTargets };

export { prettifyTargets } from "./pretty.ts";
export { getInclusionReasons } from "./debug.ts";
export { unreleasedLabels } from "./targets.ts";
export { TargetNames };

export function isBrowsersQueryValid(browsers: unknown): boolean {
  return (
    typeof browsers === "string" ||
    (Array.isArray(browsers) && browsers.every(b => typeof b === "string"))
  );
}

type GetTargetsOption = {
  // This is not the path of the config file, but the path where start searching it from
  configPath?: string;
  // The path of the config file
  configFile?: string;
  // The env to pass to browserslist
  browserslistEnv?: string;
  // true to disable config loading
  ignoreBrowserslistConfig?: boolean;
  // custom hook when browserslist config is found
  onBrowserslistConfigFound?: (configFile: string) => void;
};

export default function getTargets(
  inputTargets: InputTargets = {},
  options: GetTargetsOption = {},
): Targets {
  return {};
}

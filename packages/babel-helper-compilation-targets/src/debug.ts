import type { Target, Targets } from "./types.ts";

export function getInclusionReasons(
  item: string,
  targetVersions: Targets,
  list: { [key: string]: Targets },
) {
  return {} as Partial<Record<Target, string>>;
}

/** Stand-in for vmark's debug channels: pipeline warnings go to the console in dev only. */
export function mdPipelineWarn(...args: unknown[]): void {
  if (import.meta.env.DEV) console.warn("[markdown-pipeline]", ...args);
}

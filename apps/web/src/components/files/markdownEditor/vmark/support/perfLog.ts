/** Stand-in for vmark's opt-in perf logger. */
export function perfStart(_label: string): void {}
export function perfEnd(_label: string, _details?: Record<string, unknown>): void {}
export function perfMark(_label: string, _details?: Record<string, unknown>): void {}

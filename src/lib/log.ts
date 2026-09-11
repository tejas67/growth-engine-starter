type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.GROWTH_LOG_LEVEL as Level) ?? 'info'] ?? 20;
function emit(level: Level, stage: string, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold)
        return;
    const line = { ts: new Date().toISOString(), level, stage, message, ...(fields ?? {}) };
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(JSON.stringify(line));
}
export function logger(stage: string) {
    return {
        debug: (m: string, f?: Record<string, unknown>) => emit('debug', stage, m, f),
        info: (m: string, f?: Record<string, unknown>) => emit('info', stage, m, f),
        warn: (m: string, f?: Record<string, unknown>) => emit('warn', stage, m, f),
        error: (m: string, f?: Record<string, unknown>) => emit('error', stage, m, f),
    };
}
export type Logger = ReturnType<typeof logger>;

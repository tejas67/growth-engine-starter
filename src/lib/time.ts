export type LatencyBucket = '<1h' | '1-4h' | '4-12h' | '12-24h' | '1-3d' | '>3d';
const HOUR = 3600;
const DAY = 24 * HOUR;
export function latencyBucket(seconds: number): LatencyBucket {
    if (seconds < HOUR)
        return '<1h';
    if (seconds < 4 * HOUR)
        return '1-4h';
    if (seconds < 12 * HOUR)
        return '4-12h';
    if (seconds < DAY)
        return '12-24h';
    if (seconds < 3 * DAY)
        return '1-3d';
    return '>3d';
}
export function utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
}
export function daysBetween(a: Date, b: Date): number {
    return Math.abs(b.getTime() - a.getTime()) / (DAY * 1000);
}
export function hoursSince(at: Date, now: Date): number {
    return (now.getTime() - at.getTime()) / (HOUR * 1000);
}
export function addDays(at: Date, days: number): Date {
    return new Date(at.getTime() + days * DAY * 1000);
}
export function humanAge(at: Date, now: Date): string {
    const secs = Math.max(0, (now.getTime() - at.getTime()) / 1000);
    if (secs < 60)
        return 'just now';
    if (secs < HOUR)
        return `${Math.floor(secs / 60)}m ago`;
    if (secs < DAY)
        return `${Math.floor(secs / HOUR)}h ago`;
    const days = Math.floor(secs / DAY);
    return days === 1 ? '1 day ago' : `${days} days ago`;
}

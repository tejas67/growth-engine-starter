import { config, type ScrapeSource } from '../../config/index.js';
import { runScrape, type ScrapeSummary } from './scrape.js';
import { runUnipileScrape, type UnipileScrapeSummary } from './scrape_unipile.js';
export function selectScrapeSource(configured: ScrapeSource = config.scrape.source): ScrapeSource {
    return configured;
}
export async function runScrapeForSource(source: ScrapeSource = selectScrapeSource()): Promise<ScrapeSummary | UnipileScrapeSummary> {
    return source === 'unipile' ? runUnipileScrape() : runScrape();
}

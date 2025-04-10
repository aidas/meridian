import { $articles, $sources, inArray } from '@meridian/database';
import { DomainRateLimiter } from '../lib/rateLimiter';
import { Env } from '../index';
import { getDb } from '../lib/utils';
import { parseRSSFeed } from '../lib/parsers';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';
import { getRssFeedWithFetch } from '../lib/puppeteer';
import { startProcessArticleWorkflow } from './processArticles.workflow';
import { err, ok, ResultAsync } from 'neverthrow';

type Params = { force?: boolean };

const tierIntervals = {
  1: 60 * 60 * 1000, // Tier 1: Check every hour
  2: 4 * 60 * 60 * 1000, // Tier 2: Check every 4 hours
  3: 6 * 60 * 60 * 1000, // Tier 3: Check every 6 hours
  4: 24 * 60 * 60 * 1000, // Tier 4: Check every 24 hours
};

const dbStepConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: '1 second', backoff: 'linear' },
  timeout: '5 seconds',
};

// Takes in a rss feed URL, parses the feed & stores the data in our database.
export class ScrapeRssFeed extends WorkflowEntrypoint<Env, Params> {
  async run(_event: WorkflowEvent<Params>, step: WorkflowStep) {
    console.log('[ScrapeRssFeed] Starting workflow run', {
      force: _event.payload.force,
      eventId: _event.id
    });

    try {
      const db = getDb(this.env.DATABASE_URL);
      console.log('[ScrapeRssFeed] Database connection initialized');

      // Fetch all sources
      console.log('[ScrapeRssFeed] Fetching feeds from database');
      const feeds = await step.do('get feeds', dbStepConfig, async () => {
        let feeds = await db
          .select({
            id: $sources.id,
            lastChecked: $sources.lastChecked,
            scrape_frequency: $sources.scrape_frequency,
            url: $sources.url,
          })
          .from($sources);

        console.log(`[ScrapeRssFeed] Total feeds found in DB: ${feeds.length}`);

        if (_event.payload.force === undefined || _event.payload.force === false) {
          const beforeFilterCount = feeds.length;
          feeds = feeds.filter(feed => {
            if (feed.lastChecked === null) {
              return true;
            }
            const lastCheckedTime =
              feed.lastChecked instanceof Date ? feed.lastChecked.getTime() : new Date(feed.lastChecked).getTime();
            const interval = tierIntervals[feed.scrape_frequency as keyof typeof tierIntervals] || tierIntervals[2];
            return Date.now() - lastCheckedTime >= interval;
          });
          console.log(`[ScrapeRssFeed] Feeds after time-based filtering: ${feeds.length}/${beforeFilterCount}`);
        } else {
          console.log('[ScrapeRssFeed] Force mode enabled, skipping time-based filtering');
        }

        return feeds.map(e => ({ id: e.id, url: e.url }));
      });

      if (feeds.length === 0) {
        console.log('[ScrapeRssFeed] All feeds are up to date, exiting early...');
        return;
      }

      console.log(`[ScrapeRssFeed] Processing ${feeds.length} feeds`);

      // Process feeds with rate limiting
      const now = Date.now();
      const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const allArticles: Array<{ sourceId: number; link: string; pubDate: Date | null; title: string }> = [];

      // Create rate limiter with RSS feed specific settings
      console.log('[ScrapeRssFeed] Creating rate limiter', {
        maxConcurrent: 10,
        globalCooldownMs: 500,
        domainCooldownMs: 2000
      });

      const rateLimiter = new DomainRateLimiter<{ id: number; url: string }>({
        maxConcurrent: 10,
        globalCooldownMs: 500,
        domainCooldownMs: 2000,
      });

      // Process feeds with rate limiting
      console.log('[ScrapeRssFeed] Starting rate-limited feed processing');
      const feedResults = await rateLimiter.processBatch(feeds, step, async (feed, domain) => {
        console.log(`[ScrapeRssFeed] Processing feed ${feed.id} from domain ${domain}`);

        try {
          return await step.do(
            `scrape feed ${feed.id}`,
            {
              retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' },
            },
            async () => {
              console.log(`[ScrapeRssFeed] Fetching feed content: ${feed.url}`);
              const feedPage = await getRssFeedWithFetch(feed.url);

              if (feedPage.isErr()) {
                console.error(`[ScrapeRssFeed] Error fetching feed ${feed.url}:`, {
                  errorType: feedPage.error.type,
                  errorDetails: feedPage.error
                });
                throw feedPage.error;
              }

              console.log(`[ScrapeRssFeed] Successfully fetched feed ${feed.id}, parsing content`);
              const feedArticles = await parseRSSFeed(feedPage.value);

              if (feedArticles.isErr()) {
                console.error(`[ScrapeRssFeed] Error parsing feed ${feed.url}:`, {
                  errorType: feedArticles.error.type,
                  errorDetails: feedArticles.error
                });
                throw feedArticles.error;
              }

              const filteredArticles = feedArticles.value
                .filter(({ pubDate }) => pubDate === null || pubDate > oneWeekAgo)
                .map(e => ({ ...e, sourceId: feed.id }));

              console.log(`[ScrapeRssFeed] Feed ${feed.id} yielded ${filteredArticles.length}/${feedArticles.value.length} articles within date range`);
              return filteredArticles;
            }
          );
        } catch (error) {
          console.error(`[ScrapeRssFeed] Error processing feed ${feed.id}:`, error);
          return [];
        }
      });

      // Flatten the results into allArticles
      let articleCount = 0;
      feedResults.forEach(articles => {
        articleCount += articles.length;
        allArticles.push(...articles);
      });
      console.log(`[ScrapeRssFeed] Total articles collected: ${allArticles.length} from ${feedResults.length} feeds`);

      // Insert articles and update sources
      if (allArticles.length > 0) {
        console.log(`[ScrapeRssFeed] Inserting ${allArticles.length} new articles into database`);
        const insertResult = await step.do('insert new articles', dbStepConfig, async () =>
          db
            .insert($articles)
            .values(
              allArticles.map(({ sourceId, link, pubDate, title }) => ({
                sourceId,
                url: link,
                title,
                publishDate: pubDate,
              }))
            )
            .onConflictDoNothing()
        );
        console.log('[ScrapeRssFeed] Articles insertion completed', insertResult);

        const uniqueSourceIds = Array.from(new Set(allArticles.map(({ sourceId }) => sourceId)));
        console.log(`[ScrapeRssFeed] Updating lastChecked for ${uniqueSourceIds.length} sources`);

        const updateResult = await step.do('update sources', dbStepConfig, async () =>
          db
            .update($sources)
            .set({ lastChecked: new Date() })
            .where(inArray($sources.id, uniqueSourceIds))
        );
        console.log('[ScrapeRssFeed] Sources update completed', updateResult);
      } else {
        // If no articles were found but we processed feeds, still update the lastChecked
        console.log('[ScrapeRssFeed] No articles found, updating lastChecked for all processed feeds');

        const updateResult = await step.do('update sources with no articles', dbStepConfig, async () =>
          db
            .update($sources)
            .set({ lastChecked: new Date() })
            .where(
              inArray(
                $sources.id,
                feeds.map(feed => feed.id)
              )
            )
        );
        console.log('[ScrapeRssFeed] Sources update completed', updateResult);
      }

      console.log('[ScrapeRssFeed] Triggering article processor workflow');
      const workflowResult = await step.do('trigger_article_processor', dbStepConfig, async () => {
        const workflow = await startProcessArticleWorkflow(this.env);
        if (workflow.isErr()) {
          console.error('[ScrapeRssFeed] Failed to start article processor workflow:', workflow.error);
          throw workflow.error;
        }
        console.log('[ScrapeRssFeed] Article processor workflow started', workflow.value);
        return workflow.value.id;
      });

      console.log('[ScrapeRssFeed] Workflow completed successfully', { workflowId: workflowResult });
    } catch (error) {
      console.error('[ScrapeRssFeed] Unhandled error in workflow:', error);
      throw error; // Re-throw to make sure CloudFlare's workflow system sees the failure
    }
  }
}

export async function startRssFeedScraperWorkflow(env: Env, params?: Params) {
  console.log('[startRssFeedScraperWorkflow] Starting workflow', { params });

  const workflow = await ResultAsync.fromPromise(
    env.SCRAPE_RSS_FEED.create({ id: crypto.randomUUID(), params }),
    e => {
      console.error('[startRssFeedScraperWorkflow] Error creating workflow:', e);
      return e instanceof Error ? e : new Error(String(e));
    }
  );

  if (workflow.isErr()) {
    console.error('[startRssFeedScraperWorkflow] Workflow creation failed:', workflow.error);
    return err(workflow.error);
  }

  console.log('[startRssFeedScraperWorkflow] Workflow started successfully', { id: workflow.value.id });
  return ok(workflow.value);
}
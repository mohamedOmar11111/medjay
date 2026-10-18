# Trending and viral data sources: feasibility and ToS

Date: 2026-10-17. Web research only. **Reddit's own policy pages (redditinc.com, support.reddithelp.com) returned 403 in the research session; Reddit findings come from third-party summaries and one Nov 2025 r/redditdev post. Re-verify against Reddit's primary terms before any product decision.** Prices are third-party figures, mostly unverified.

## Platform table

| Platform | Best legitimate method | Cost / risk | BYO key feasible? |
|---|---|---|---|
| Reddit | Official Data API, approval-gated (Responsible Builder Policy, Nov 2025); or licensed third-party data | Free tier reported non-commercial only; commercial needs a separate agreement. Reported figures ($0.24 per 1k calls; $12k/yr or $12k/mo minimums) conflict. HIGH risk for a product | Partly. User's own approved app is a personal-use grey zone; a vendor selling a product needs its own commercial deal |
| TikTok | Creative Center (web UI; no confirmed official API); third-party APIs | Research API is academic/non-profit only (US, EEA, UK, CH, Brazil); commercial users ineligible. Third-party about $1.70 per 1k videos (Apify). Scraping is ToS-grey | User's Business API token returns only their own data. Third-party BYO key works |
| Instagram / Facebook | Graph API hashtag top_media for the user's own Business/Creator account | 30 unique hashtags per rolling 7 days; needs App Review for Public Content Access. Meta Content Library is not-for-profit research only. Third-party about $1.50 per 1k | Yes per user, needs a Meta app with App Review |
| YouTube | Data API v3 `videos.list?chart=mostPopular` | Free; 10k units/day default; search about 100 units (third-party figure); quota increase by form. LOW risk | Yes (user's own Google Cloud key) |
| X / Twitter | Official pay-per-use API | About $0.005 per post read, $0.010 per user read (third-party). Basic/Pro reportedly closed to new signups. Read cap reported 2M-3M posts/month, unconfirmed | Yes (user buys credits) |
| LinkedIn | No public post-search or trending API (search is partner-only) | Scraping violates ToS. HIGH risk | No for trends; manual input or exports |
| Google Trends | Official Trends API (alpha, July 2025, application-based) | No GA found; pricing/quotas not public; no "Trending Now"; pytrends archived Apr 2025. Providers like DataForSEO/SerpApi (2026 pricing unverified) | Only with alpha access; otherwise a paid provider |
| Pinterest | Trends API (`List trending keywords`) | Selected partners only; today's trends, max 50 | Rarely |
| Threads | Official keyword and topic-tag search | 2,200 queries / rolling 24h per user (Meta docs, Jan 2026); a reported 500/7-day cap conflicts; needs permissions, likely App Review; no trending endpoint | Yes (per-user token) |
| Telegram | MTProto API with user's own account, or TGStat API | ToS cites content-licensing and AI-scraping terms; unclear whether public-channel API reads are covered. TGStat about $5-160/mo (secondary); coverage mostly Russian | Yes (own api_id); compliance unclear |

## Recommended v1 minimal set
1. YouTube Data API (free, clean, BYO key).
2. X pay-per-use API (BYO credits).
3. Google Trends via official API if the user has alpha access, otherwise a paid provider (DataForSEO or similar).
4. Threads keyword search and Instagram hashtag top_media (user's own Meta app and token; heavier setup).
5. One BYO third-party scraper key (Apify or similar) for TikTok, Instagram, Reddit. Cost and ToS responsibility sit with the user and the vendor.
6. Exa or Firecrawl for open-web and news signals (pricing not researched).

Skip in v1: LinkedIn, Pinterest Trends, Meta Content Library, Telegram.

## Red flags for a product (not just a personal tool)
- **Reddit (highest):** commercial use reportedly needs a separate agreement; Data API terms reportedly bar using content for ML/AI training without permission (single source, Vorp Labs); new OAuth tokens need manual approval. Do not ship a product that scrapes Reddit directly or resells Reddit data. Surface Reddit content only via the user's own approved credentials or a licensed provider. Have counsel read the primary terms.
- **TikTok Research API:** commercial users ineligible. Do not route a product through an academic account.
- **Meta Content Library:** not-for-profit research only.
- **Scraping logged-in or ToS-protected platforms:** legality is jurisdiction-dependent; it is a clear contract/ToS breach. Bundling scrapers moves risk to the vendor; BYO key shifts it to the user but does not remove vendor exposure if the scraper ships in the product.
- **Storing/redistributing content:** most official APIs limit caching, require deletion sync, or bar republishing. Store signals and metrics, not full content, and link back to the source.
- **Telegram:** do not bulk-collect channel content until the API Developer Terms are read (not retrieved).

## Arabic and MENA
- Crowd Analyzer, AIM Insights: vendor-claimed Arabic dialect coverage (Gulf, Egyptian, Levantine, North African, Arabizi); self-claims, no independent benchmark.
- TGStat: mainly Russian-language; Arabic coverage unconfirmed.
- Official APIs filtered by region/language: X (`lang:ar`, Saudi/UAE geo), YouTube (`regionCode=SA/AE/EG`), Google Trends (region codes), Threads keyword search with Arabic terms.
- Not researched: Snapchat (Spotlight is big in KSA; no API checked), Brandwatch / Talkwalker / Mentionlytics specifics, Arabic trends on X.

## Not researched
Bright Data, DataForSEO, Exa and Firecrawl pricing; SocialKit; Facebook Page-level trending; LinkedIn ToS / hiQ outcome.

## Sources
Reddit: octolens.com/blog/reddit-api-pricing; techloy.com (Reddit API pricing 2026); vorplabs.com/agent-tools/reddit-data-api; r/redditdev thread (Responsible Builder Policy). TikTok: xpoz.ai; datashake.com. X: bundle.social/blog/x-api-pricing-2026-costs-limits; opentweet.io/x-api-pricing. Google Trends: developers.google.com/search/blog/2025/07/trends-api; scrapfly.io. Meta: developers.facebook.com (Content Library FAQ, Instagram hashtag search, Threads keyword search). YouTube: developers.google.com/youtube/v3 (quota cost, getting started). Pinterest: developers.pinterest.com/docs/analytics-and-reports/trends. LinkedIn: ayrshare.com blog. Telegram: telegram.org/tos; github.com/selesnow/rtgstat. Apify pricing: use-apify.com; socialcrawl.dev. Arabic tools: getapp.com.au (Crowd Analyzer); aimtechnologies.co.

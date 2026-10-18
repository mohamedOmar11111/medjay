# Competitive landscape

Date: 2026-10-17. Method: web search snippets only; vendor pages and repos were not opened. Star counts and prices come from third-party aggregators and are marked (unv.) = unverified. Re-verify before using any figure externally.

## Comparison

| Product | What / model | Target | Platforms | CLI / BYO | Weakness |
|---|---|---|---|---|---|
| coreyhaines31/marketingskills | MIT markdown skill pack (CRO, copy, SEO, analytics). Stars reported 21k-49k (unv.) | Founders, growth people | None directly (prompts) | Any agent, BYO model | No ad execution, no approvals, no client workspaces |
| OpenClaudia/openclaudia-skills | 56+ skills, about 325 stars (unv.) | Solo marketers | SEO, email, social | Claude Code | Prompt pack, no guardrails |
| BrianRWagner/ai-marketing-claude-code-skills | about 344 stars (unv.) | Solo marketers | Writing, strategy | Claude Code / OpenClaw | Same |
| Adspirer | Hosted MCP. Free (15 calls/mo), $49 / $99 / $199 (3,000 calls) | Agencies, in-house | Google, Meta, LinkedIn, TikTok (tool count reports conflict: 100+ vs 178+) | No CLI; BYO model via MCP client | Call-metered, closed, connectors drop every 1-2 weeks |
| Ryze AI | Hosted MCP + autopilots. $89/mo ads, $129 SEO, up to $1,499 (vendor-reported) | SMBs, agencies | Google, Meta, TikTok, Shopify, SEO | MCP, OAuth | Closed. Reportedly read-heavy (source is a competitor, biased) |
| Pipeboard | CLI + MCP. CLI open source but calls their server; Meta MCP under BUSL 1.1; about 678 stars (unv.); Free 30/wk, about $29.90 Pro (unv.) | Agents, developers | Meta, Google, TikTok | CLI, BYO model, but credentials held by Pipeboard | Source-available not OSI-open; credentials on vendor server |
| irinabuht12-oss/google-meta-ads-ga4-mcp | MIT MCP server, about 1k stars (unv.) | Developers | Google, Meta, GA4 | BYO keys | Server only, no agent, no gates |
| amekala/ads-mcp | Open MCP server, 54 stars (unv.) | Hobbyists | Google, Meta, LinkedIn, TikTok | BYO keys | Immature |
| Madgicx | SaaS about $45/mo, spend-based (unv.) | Meta-heavy ecommerce | Meta, Google | None | Closed, Meta-centric |
| Albert.ai / Smartly | Enterprise, quote only; Smartly about $5k/mo (unv.) | Enterprise | Multi-channel | None | Price, lock-in |
| AdCreative.ai | $29-39/mo (unv.) | SMBs | Creative output | None | Not an agent |
| Jasper | $59-69 per seat; agents on custom plan | Content teams | Content | None | Seat pricing, no ad ops |
| Zapier Agents | Task-priced from about $20 (unv.) | Ops teams | 8,000+ apps | No CLI | Generic |
| HubSpot Breeze | Credits $10 per 1,000, outcome-priced since Apr 2026; Pro/Enterprise | HubSpot shops | HubSpot | None | CRM lock-in, thin paid media |
| Semrush / Ahrefs MCP | Bundled in paid plans; Ahrefs Lite $129/mo and metered | SEOs | SEO data | MCP, BYO model | Data only |
| YC startups (Uplane, The Hog, Lapis) | "Replace the agency" SaaS | SMBs | Meta, Google, LinkedIn, social | None | Closed black box; funding not found |

No marketing-specific OpenClaw or Hermes harness was found (search was shallow). Pipeboard markets its CLI for OpenClaw.

## Whitespace
1. A real open harness, not a skill pack: CLI + multi-provider agent loop + ad-platform tools, OSI-licensed.
2. Approval gates as a core primitive: spend caps, dry-run diff, audit log. No open implementation found.
3. Client workspaces as files (brand voice, ICP, offers, accounts, budgets).
4. BYO keys and model with no call metering.
5. One loop across ads, SEO, content, research, reporting.

## Platform API risks (verify against primary docs)
- **Google Ads:** reports conflict. Third-party coverage (PPC Land, Relevant Audience) says developer tokens were sunset 2026-09-09 with access tied to the Cloud project and brand verification. Google's own policy page may still describe the old flow. **Check developers.google.com/google-ads/api/docs/api-policy before designing around either.**
- **Meta:** managing other people's ad accounts needs Advanced Access, which needs Business Verification. Standard Access has usage thresholds (reported: 1,500 calls, under 10% errors). Users on their own accounts can use Standard Access.
- **LinkedIn:** advertising API by application, approval discretionary; development tier limited to 5 ad accounts for writes. Hardest platform for a hosted service.
- **TikTok:** app review plus data-security check; 1-2 weeks or longer (blog-sourced).
- Local-first with user-owned credentials avoids most approval gates but moves policy risk to the user. Agent-driven writes may still breach platform automation policies (unverified).

## Monetization that fits
- Open core: MIT engine free; paid team governance, hosted sync/scheduling/relay, premium vertical packs.
- Skills marketplace only for premium, tested, versioned packs (free packs already draw huge stars).
- Avoid per-call metering (Adspirer's model; the thing BYO-key buyers want to escape).

## Sources
star-history.com/coreyhaines31/marketingskills; skillrank.it.com; sourcepulse.org (openclaudia, google-meta-ads-ga4-mcp); agentskill.work; adspirer.com FAQ; get-ryze.ai; adkit.so/alternatives/ryze; pipeboard.co guides + github.com/pipeboard-co/meta-ads-mcp; gittrend.io/repo/amekala/ads-mcp; toolradar.com (Madgicx, Smartly, AdCreative); eesel.ai (Jasper); aiagentrank.io; resolve247.ai (HubSpot Breeze); contextbolt.com (Semrush MCP); mcp.directory (Ahrefs MCP); ycombinator.com/companies/industry/advertising; ppc.land; relevantaudience.com; developers.google.com/google-ads/api/docs/api-policy; developers.facebook.com/docs/marketing-api/access; learn.microsoft.com/linkedin/marketing/increasing-access; bundle.social/blog/tiktok-api-approval.

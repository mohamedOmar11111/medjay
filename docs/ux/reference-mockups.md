# Reference UX mockups

Source: owner blueprint, 2026-10-17. **All numbers, names and results below are ILLUSTRATIVE.** They show layout and flow, not real data or validated results. Edits made while importing are marked `[spec change]`; the reasons are in SPEC.md section 24.

## A. Terminal flow (`mdj scout` -> `simulate` -> dry-run diff -> `strike`)

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  MEDJAY v0.1.0  .  The Growth Architect Harness & Tactical Sword             │
│  Workspace: etlaala-ksa (Travel & Tourism / MENA Strike Pack v1.2)           │
│  Shield: ACTIVE (Max increase: +20%/day | Hard spend cap: $1,500/day)       │
│  [ILLUSTRATIVE DATA]                                                         │
╰──────────────────────────────────────────────────────────────────────────────╯

$ mdj scout --days 7 --pillars ads,conversational,offer,geo

  ok [fast:ollama/qwen2.5] Ingested 7d data (GA4 + Meta + Google + Respond.io CRM)
  ok [truth-check] Platform-reported bookings: 14 | CRM-confirmed: 9 | match rate 86% | Blended MER 4.2x
  ok [reasoning:<model>] Auditing active pillars & Tested-Tactics Log...

=== DIAGNOSIS (3 ANOMALIES, 1 SHADOW SCOUT ALERT) ============================

  1. [BLEED] Meta AdSet "KSA_Honeymoon_Maldives_Broad" - zero-pipeline spend
     |- Evidence: spend $640 (7d) -> 48 WhatsApp clicks -> 0 qualified CRM deals
     |- Likely cause: broad targeting optimizing for cheap clicks; 71% ghosted after price reply
     '- Source: data/imports/meta_7d.csv + data/imports/respondio_stages.json  (2026-10-10..16)

  2. [FUNNEL] Landing page "/ar/maldives-offers" - offer and conversational friction
     |- Evidence: 68% mobile bounce; no BNPL messaging above the fold
     '- Matched tactic: [TACTIC-MENA-019] sticky WhatsApp concierge + BNPL badge
        Vault prior: validated in 3 other workspaces (evidence_scope: vault_prior)
        Local status: unverified here -> will register EXP-088

  3. [GEO] AI search visibility - "best family resort packages Georgia from Riyadh"
     '- Evidence: brand cited in 0/5 sampled Perplexity & ChatGPT answers; no `TouristTrip` JSON-LD

=== UNIT-ECONOMICS SIMULATION (mdj simulate --plan 04) ========================

  Inputs: context/unit-economics.md (ranges) | Monte Carlo 10,000 draws | seed 20261017
  Assumption flagged: CPC elasticity on scale = default (not yet estimated from your data)
  Projected 14d contribution-margin delta: P10 +$420 | P50 +$1,840 | P90 +$3,100 /week
  P(margin delta > 0) = 78%  (conditional on model and inputs)
  Most sensitive inputs: chat-to-qualified %, CPC elasticity, lead-to-chat %

=== PROPOSED STRIKE PLAN (#PLAN-04 v1) ========================================

  a1  Meta AdSet 23859102938 "Maldives_Broad"
      - daily_budget: $95.00/day
      + daily_budget: $35.00/day   (-63.2% | Shield: decrease allowed)
  a2  Meta AdSet 23859994110 "KSA_CRM_Bookers_LAL_1%"
      - daily_budget: $100.00/day
      + daily_budget: $120.00/day  (+20.0% | Shield: at the +20% increase limit)
  a3  Patch -> patches/PLAN-04-maldives-hero-schema.diff   [exported, never auto-deployed]
      + `TouristTrip` JSON-LD + sticky WhatsApp/BNPL hero component
      + Register experiment EXP-088 linked to TACTIC-MENA-019

  Shield: PASS   Plan hash: sha256:9f4a2c...   Expires: 19 Oct 10:40
------------------------------------------------------------------------------
  Syncing approval request to WhatsApp (+20 10XXXXXXX)... SENT.
  Execute plan #04 now? [S]trike / [H]old / [D]rop / [E]dit (cap) / s[I]mulate again: _
```
`[spec change]` simulation shows P10/P50/P90 and a defined probability instead of a bare "Confidence 78%"; the vault result is labelled a prior; per-action status (a3 is exported); the prompt uses STRIKE/HOLD/DROP wording; an `--ascii` fallback exists for terminals without Unicode or emoji.

## B. WhatsApp command and approval UX

```
Medjay Agent (Business Command)                                10:14 AM
--------------------------------------------------------------------------
*MEDJAY DAILY PULSE - Etlaala (KSA)*   [ILLUSTRATIVE DATA]
Shield: Active | Blended MER: *4.2x*

*Spend (24h):* $812 / $1,500 cap
*WhatsApp qualified leads:* 34 ($23.8 CPL)
*CRM bookings:* 6 ($135 real CAC)
_(Meta and Google claimed 10 bookings; calibrated against Respond.io CRM, match rate 86%)_

*Bleeding ad set caught:*
"KSA_Honeymoon_Maldives_Broad": $640 (7d), 0 qualified CRM deals (71% ghosted on price)

*PROPOSED STRIKE (#PLAN-04):*
1. Cut "Maldives_Broad": *$95 -> $35/day*
2. Scale "KSA_Bookers_LAL": *$100 -> $120/day*
3. Experiment *EXP-088*: sticky WhatsApp + BNPL badge and `TouristTrip` patch (exported as a diff)

*Simulation:* margin delta P10 +$420 / P50 +$1,840 / P90 +$3,100 per week; P(>0) 78%
_Shield check: net budget delta -$40/day (PASS). Plan 04 | hash 9f4a2c | expires 19 Oct 10:40_

Reply with:
*STRIKE 04*   approve and execute exactly this plan
*HOLD 04*     keep as draft
*DROP 04*     reject
*CAP 04 50*   set action 1 (Maldives_Broad) to $50/day (creates plan 04 v2 for approval)
--------------------------------------------------------------------------
                                                         10:15 AM  (you)
                  Voice note 0:09: "Strike 04 now, and run a shadow scout
                  on competitors running Georgia winter packages in Riyadh."
--------------------------------------------------------------------------
Medjay:
Heard two requests.
(1) Shadow scout queued: `mdj scout --shadow "Georgia Winter KSA"` - brief in ~45s.
(2) Strike needs a typed confirmation. Reply *STRIKE 04* to execute plan 04 (hash 9f4a2c).
                                                         10:15 AM  (you)
                                                         STRIKE 04
Medjay:
STRIKE #04: a1, a2 *executed* (Meta); a3 *exported* (patch ready for review).
Audit entry #1287, hash `9f4a2c`. EXP-088 registered.
--------------------------------------------------------------------------
```
`[spec change]` voice note can queue the shadow scout but cannot approve; the strike needs a typed `STRIKE 04` that binds the plan hash; per-action results are shown (executed vs exported); `DROP` added; `CAP` yields a new plan version. Template and 24-hour-window rules decide how the pulse and cards are delivered (SPEC section 16).

## C. Plain-file client workspace

```
workspaces/etlaala-ksa/
  workspace.yaml             business type, active pillars, tiered model routing, connectors, vault consent
  shield.policy.yaml         spend caps, increase/decrease limits, circuit breakers, WhatsApp ACL
  context/
    brand-voice.md           Khaleeji / Egyptian / MSA rules, tone, forbidden phrases
    unit-economics.md        target CPA, funnel rates with ranges, margins
    offer-matrix.md          packages, decoy tiers, BNPL hooks
    seasonal-calendar.md     Ramadan, Eid, Saudi National Day, summer windows
  tactics/
    mena-travel-pack.md      starter tactics from the pack (shipped as unverified, with sources)
    tested-tactics-log.md    generated index; per-tactic state in frontmatter
  data/imports/              dropzone: GA4 / Meta / GSC / Respond.io exports
  plans/                     deterministic .plan.json and patches
  .medjay/                   machine state (never hand-edited)
    audit-log.jsonl          append-only hash chain (tamper-evident)
    experiments.db           SQLite: experiments, runs, facts, plan index, telemetry
    gateway/                 webhook and session state for the mobile bridge
```
`[spec change]` audit log described as tamper-evident, not "cryptographic ledger"/"immutable"; `gateway/` holds Cloud API/Respond.io webhook state (the local session bridge is experimental).

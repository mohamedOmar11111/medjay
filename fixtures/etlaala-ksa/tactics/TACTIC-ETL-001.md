---
id: TACTIC-ETL-001
title: Pause ad sets with spend but no CRM deal after five active days
matches:
  - bleeding_adset
source:
  kind: practitioner
  ref: internal review of etlaala-ksa, September 2026 (synthetic)
  date: 2026-09-30
state: unverified
tags:
  markets:
    - KSA
  verticals:
    - travel
---
# Pause ad sets that bleed

If an ad set has at least five active days, at least 5% of spend, and the CRM shows no deal from it, pause it and
move the budget to the ad set with the lowest cost per deal. Test it before treating it as a rule.

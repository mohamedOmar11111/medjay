---
id: TACTIC-ETL-002
title: Allocate budget by the platform's own reported conversions
matches:
  - over_attribution
source:
  kind: vendor
  ref: platform best-practice guide (synthetic)
  date: 2026-08-15
state: invalidated
experiment:
  id: EXP-ETL-014
  hypothesis: Budget shifted by platform-reported conversions improves cost per CRM deal by at least 10%
  metric: cost_per_deal_sar
  baseline:
    value: 1040
    range: 2026-08-01..2026-08-28
    snapshot_id: snap_etl_014
  design:
    type: before_after
    min_sample: 40
    duration_days: 28
    min_effect: 0.1
result:
  confidence: 0.04
  method: bayesian
  sample_size: 63
  date_range: 2026-08-29..2026-09-26
  effect: -0.12
  outcome_source: crm
  grading: outcome
  caveats:
    - synthetic result for the fixture
---
# Do not allocate by platform-reported conversions

Tested on etlaala-ksa and it made cost per CRM deal worse. Kept so it is not proposed again.

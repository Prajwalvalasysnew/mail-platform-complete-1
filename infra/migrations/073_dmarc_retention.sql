-- Bound DMARC retention sweeps by report period. The existing customer-first
-- indexes serve tenant dashboards; this global date-first index serves the
-- worker's cross-tenant lifecycle scan without a full-table sort.
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_retention
    ON dmarc_reports (date_range_end, id);

-- DMARC aggregate-report monitoring.
--
-- The dominant need across the ICP corpus (983 DMARC mentions): institutions
-- publish rua= records that dump aggregate-report XML into an inbox nobody
-- reads. This ingests those reports, parses them, and turns them into a
-- "who is sending as your domain, and is it authenticated?" view — the exact
-- job EasyDMARC/Valimail/Dmarcian do, and the natural sequel to the domain
-- scanner + DKIM signing + SMTP relay already built.
--
-- Reporting address: each customer gets a token so receivers send reports to
-- rua=mailto:<token>@<DMARC_REPORT_DOMAIN>; the inbound path resolves the
-- token back to the tenant. The token lives on customers (which is itself the
-- tenant, not RLS-scoped) so the un-authenticated ingest path can resolve it.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS dmarc_report_token TEXT UNIQUE;

-- One row per received aggregate report (per reporter, per period).
CREATE TABLE IF NOT EXISTS dmarc_reports (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    domain            TEXT NOT NULL,            -- policy_published.domain
    org_name          TEXT NOT NULL,            -- reporter (e.g. google.com)
    report_id         TEXT NOT NULL,            -- reporter's report id
    date_range_begin  TIMESTAMPTZ NOT NULL,
    date_range_end    TIMESTAMPTZ NOT NULL,
    policy_p          TEXT,                     -- none | quarantine | reject
    policy_sp         TEXT,
    policy_pct        INTEGER,
    policy_adkim      TEXT,                     -- r | s
    policy_aspf       TEXT,
    total_messages    BIGINT NOT NULL DEFAULT 0,
    aligned_messages  BIGINT NOT NULL DEFAULT 0,  -- passed DMARC (dkim OR spf aligned)
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, org_name, report_id)
);

CREATE INDEX IF NOT EXISTS idx_dmarc_reports_customer
    ON dmarc_reports (customer_id, date_range_begin DESC);
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain
    ON dmarc_reports (customer_id, domain, date_range_begin DESC);

-- One row per <record> (a source IP's aggregated result within a report).
CREATE TABLE IF NOT EXISTS dmarc_report_records (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_id     UUID NOT NULL REFERENCES dmarc_reports(id) ON DELETE CASCADE,
    customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    domain        TEXT NOT NULL,
    source_ip     TEXT NOT NULL,
    message_count BIGINT NOT NULL DEFAULT 0,
    disposition   TEXT,                         -- none | quarantine | reject
    dkim_result   TEXT,                         -- pass | fail (policy_evaluated)
    spf_result    TEXT,
    header_from   TEXT,
    spf_domain    TEXT,
    dkim_domain   TEXT,
    dmarc_pass    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dmarc_records_report
    ON dmarc_report_records (report_id);
CREATE INDEX IF NOT EXISTS idx_dmarc_records_source
    ON dmarc_report_records (customer_id, domain, source_ip);

-- Fail-closed tenant RLS, matching migration 043.
ALTER TABLE dmarc_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmarc_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY dmarc_reports_tenant ON dmarc_reports FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

ALTER TABLE dmarc_report_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmarc_report_records FORCE ROW LEVEL SECURITY;
CREATE POLICY dmarc_report_records_tenant ON dmarc_report_records FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

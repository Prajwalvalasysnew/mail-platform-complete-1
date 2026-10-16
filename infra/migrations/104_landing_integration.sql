-- Authentication-plane tickets: raw codes/session tokens are never stored.
CREATE TABLE workspace_handoffs (
 code_hash TEXT PRIMARY KEY,
 session_id UUID NOT NULL UNIQUE REFERENCES user_sessions(id) ON DELETE CASCADE,
 destination TEXT NOT NULL CHECK(destination IN ('workspace','onboarding')),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspace_handoffs_expiry ON workspace_handoffs(expires_at);

-- Public intake, not tenant data. Only the authenticated admin plane lists it.
CREATE TABLE landing_sales_requests (
 id UUID PRIMARY KEY,
 request_hash TEXT NOT NULL,
 first_name TEXT NOT NULL, last_name TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL, company TEXT NOT NULL,
 monthly_volume TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
 consent_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX landing_sales_requests_created ON landing_sales_requests(created_at DESC);
REVOKE ALL ON workspace_handoffs,landing_sales_requests FROM PUBLIC;

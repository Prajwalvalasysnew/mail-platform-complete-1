-- CAN-SPAM Section 5 requires a valid physical postal address in every
-- commercial email. Store it on the customer record so the send worker
-- can append it to every outgoing message footer.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS physical_address text;

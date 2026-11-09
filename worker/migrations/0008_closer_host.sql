-- Email of the GHL user hosting the closer call; the Google Meet conference is read as this account.
ALTER TABLE leads ADD COLUMN closer_host TEXT;

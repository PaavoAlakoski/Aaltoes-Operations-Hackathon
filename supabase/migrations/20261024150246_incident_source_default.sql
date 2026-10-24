-- Clients never send source: the stamp_incident trigger sets it from the
-- caller's role. A default lets the generated insert types say so too.
alter table public.incidents alter column source set default 'system';

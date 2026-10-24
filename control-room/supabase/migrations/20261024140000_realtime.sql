-- Stream changes to the app. Realtime still applies row-level security, so
-- browsers only receive rows they could already select.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

alter publication supabase_realtime add table public.decisions, public.autonomy, public.records;

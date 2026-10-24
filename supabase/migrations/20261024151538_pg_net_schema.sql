-- pg_net was created in public by ops_agent; keep extensions out of the API
-- schema. Its functions live in the net schema either way, and the triggers
-- resolve net.http_post when they fire, so nothing else changes.
drop extension if exists pg_net;
create extension pg_net with schema extensions;

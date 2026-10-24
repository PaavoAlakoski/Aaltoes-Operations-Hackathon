-- The advisor flagged the helper's search_path as mutable. Pin it.
alter function public._allowed_actions(text, text) set search_path = public;

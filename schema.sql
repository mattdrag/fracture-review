-- Run once in Supabase → SQL Editor.
create table if not exists public.reviews (
  reviewer    text primary key,          -- lowercased name
  display     text not null,             -- name as typed
  grades      jsonb not null default '{}'::jsonb,  -- { "<card id>": 0..12 }
  notes       jsonb not null default '{}'::jsonb,  -- { "<card id>": "text" }
  submitted   boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- Expose just this table to the website (needed when "automatically expose new tables" is off).
grant usage on schema public to anon;
grant select, insert, update on public.reviews to anon;

alter table public.reviews enable row level security;

-- Friends-only honor system: anyone with the anon key can read and write, nobody can delete.
create policy "read reviews"   on public.reviews for select using (true);
create policy "create reviews" on public.reviews for insert with check (true);
create policy "update reviews" on public.reviews for update using (true) with check (true);

-- Run this in your Supabase SQL Editor

-- 1. runner_locations — live GPS positions (you already have this)
create table if not exists runner_locations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  team_id text,
  display_name text,
  latitude double precision not null,
  longitude double precision not null,
  updated_at timestamptz not null default now()
);

-- Enable realtime for live updates
alter publication supabase_realtime add table runner_locations;

-- 2. run_sessions — completed run history
create table if not exists run_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  team_id text,
  distance_km double precision not null default 0,
  duration_seconds integer not null default 0,
  pace_per_km double precision not null default 0,
  sqm_covered integer not null default 0,
  route jsonb default '[]',
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- Row Level Security (allow all for now, lock down later)
alter table runner_locations enable row level security;
alter table run_sessions enable row level security;

create policy "Public read runner_locations" on runner_locations for select using (true);
create policy "Public upsert runner_locations" on runner_locations for insert with check (true);
create policy "Public update runner_locations" on runner_locations for update using (true);
create policy "Public delete runner_locations" on runner_locations for delete using (true);

create policy "Public read run_sessions" on run_sessions for select using (true);
create policy "Public insert run_sessions" on run_sessions for insert with check (true);

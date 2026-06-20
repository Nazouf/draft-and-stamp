-- =====================================================================
-- Draft & Stamp — Supabase schema
-- Run this entire file in the Supabase SQL Editor (one paste, one run).
-- =====================================================================

-- profiles: one row per registered user (auto-created on signup)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  is_admin boolean default false,
  created_at timestamptz default now()
);

alter table profiles enable row level security;
create policy "Users can read own profile"   on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- Auto-create a profile row whenever a new user signs up
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- runs: one row per completed pipeline (saved after GENERATE step)
create table if not exists runs (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid references auth.users on delete set null,
  created_at    timestamptz default now(),
  request       text not null,
  destination   text not null,
  category      text,
  complexity    text,
  stakes        text,
  output_format text,
  mode          text,
  qa_pairs      jsonb default '[]',
  generated_prompts jsonb default '[]'
);

alter table runs enable row level security;
create policy "Anyone can insert runs"    on runs for insert with check (auth.uid() = user_id or user_id is null);
create policy "Users can read own runs"  on runs for select using (auth.uid() = user_id);

-- feedback: thumbs up/down per run
create table if not exists feedback (
  id         uuid default gen_random_uuid() primary key,
  run_id     uuid references runs on delete cascade,
  user_id    uuid references auth.users on delete set null,
  rating     integer check (rating in (1, -1)),  -- 1 = thumbs up, -1 = thumbs down
  comment    text,
  created_at timestamptz default now()
);

alter table feedback enable row level security;
create policy "Anyone can insert feedback" on feedback for insert with check (true);
create policy "Users can read own feedback" on feedback for select using (auth.uid() = user_id);

-- settings: key-value table for admin-controlled flags
create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz default now()
);

alter table settings enable row level security;
create policy "Anyone can read settings" on settings for select using (true);
-- Only the service role key (used by server.js) can write to settings — no RLS insert/update policy needed.

-- Default settings
insert into settings (key, value) values ('unrestricted_mode', 'true')
on conflict (key) do nothing;

-- =====================================================================
-- After running this:
-- 1. Go to Authentication > Providers in Supabase dashboard
-- 2. Enable Email (already on by default)
-- 3. To enable Google: enable Google provider, paste in your
--    Google OAuth Client ID and Secret (from console.cloud.google.com)
--    Callback URL to paste into Google: shown in the Supabase Google provider panel
-- 4. Copy your Project URL and anon key from Settings > API
-- 5. Copy your service_role key from Settings > API (keep this secret)
-- 6. Add to Render env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
-- 7. Add to local .env: same three vars
-- =====================================================================

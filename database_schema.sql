-- =========================================================
-- PROMPT-ENGINEERING ASSISTANT — DATABASE SCHEMA (PostgreSQL / Supabase)
-- =========================================================
-- Design notes:
-- - Checklists and stage templates are DATA, not code, so the
--   content can be tuned/tested without a redeploy.
-- - The anonymous -> email -> paid funnel is modeled as two
--   separate identity tables (anon_sessions, users) rather than
--   one, since an anonymous device token is a soft, resettable
--   signal and an email account is a real identity — collapsing
--   them would make the funnel harder to reason about.
-- - usage_events logs per MODEL CALL, not per session, so token
--   spend stays traceable back to which step (and which model)
--   is actually driving cost.

-- =========================================================
-- Users (email-tier and paid-tier accounts)
-- =========================================================
create table users (
  id                          uuid primary key default gen_random_uuid(),
  email                       text unique not null,
  tier                        text not null default 'free' check (tier in ('free','paid')),
  stripe_customer_id          text,                 -- null until/unless they ever pay
  converted_from_anon_session uuid,                 -- preserves funnel history on signup
  credits_used_this_period    integer not null default 0,
  period_started_at           timestamptz not null default now(),
  created_at                  timestamptz not null default now()
);

-- =========================================================
-- Anonymous sessions (pre-signup, soft device/browser tracking)
-- Deliberately resettable (cookie/local-storage based) — not
-- meant to be airtight, just enough to gate casual use.
-- =========================================================
create table anon_sessions (
  id              uuid primary key default gen_random_uuid(),
  device_token    text unique not null,
  credits_used    integer not null default 0,    -- see usage_limits note on credit weighting
  first_seen_at   timestamptz not null default now(),
  last_used_at    timestamptz not null default now()
);

alter table users
  add constraint fk_converted_anon
  foreign key (converted_from_anon_session) references anon_sessions(id);

-- =========================================================
-- Usage limit configuration — tunable funnel numbers, kept as
-- data so they can change without touching application code.
-- =========================================================
-- IMPORTANT: uses_per_period is denominated in CREDITS, not raw request
-- counts. Credit cost is computed by application code when a session
-- completes, not stored as data, since it's a simple deterministic rule:
--   small task            = 1 credit
--   big task               = 2 credits base + 1 credit per final stage
--                            (so: collapsed-to-1-stage = 3, up to a
--                            4-stage max = 6)
-- This intentionally means anonymous users (2 credits total) can never
-- afford a big task (cheapest is 3) — going deeper requires the email
-- signup, by construction, not by a separate arbitrary gate.
create table usage_limits (
  tier              text primary key check (tier in ('anonymous','free','paid')),
  uses_per_period   integer not null,    -- in credits, see note above
  period_days       integer,              -- null = one-time allowance, never resets
  updated_at        timestamptz not null default now()
);

insert into usage_limits (tier, uses_per_period, period_days) values
  ('anonymous', 2, null),
  ('free',      8, 30),
  ('paid',      999999, 30);   -- effectively unlimited; adjust when pricing is set

-- =========================================================
-- Checklist questions — the fixed per-category question bank.
-- options/hint are written for non-technical readers (see
-- system_prompts.md for the wording rules these must follow).
-- =========================================================
create table checklist_questions (
  id            text primary key,        -- e.g. 'writing.audience'
  category      text not null,
  priority      integer not null,        -- lower = asked earlier when several remain
  text          text not null,
  input_type    text not null check (input_type in ('single_select','multi_select','slider','free_text')),
  options       jsonb,                   -- [{label, example}], null for free_text
  hint          text,                    -- shown only if the person taps "what does this mean?"
  version       integer not null default 1,
  active        boolean not null default true
);

create index idx_checklist_active on checklist_questions (category) where active;

-- =========================================================
-- Stage templates — the fixed per-category menu of possible
-- output stages for big tasks. trigger_rule is evaluated against
-- the interview's answers by application code (kept simple here
-- on purpose — see system_prompts.md, step 3, for the actual
-- decision logic, which also handles merging and collapsing).
-- =========================================================
create table stage_templates (
  id            text primary key,        -- e.g. 'financial_model.detail_buildout'
  category      text not null,
  order_index   integer not null,
  title         text not null,
  purpose       text not null,
  trigger_rule  jsonb not null,          -- {"question_id": "...", "include_if_in": [...]} etc.
  active        boolean not null default true
);

create index idx_stage_active on stage_templates (category) where active;

-- =========================================================
-- Interview sessions — one row per request, start to finish.
-- =========================================================
create table interview_sessions (
  id                    uuid primary key default gen_random_uuid(),
  anon_session_id       uuid references anon_sessions(id),
  user_id               uuid references users(id),
  original_request      text not null,
  destination           text,            -- 'claude','chatgpt','gemini','midjourney','general',...
  primary_category      text,
  secondary_category    text,
  complexity            text check (complexity in ('small','big')),
  mode                  text not null check (mode in ('fast','interview')),
  answers               jsonb not null default '[]',   -- [{question_id, source, answer}]
  removed_question_ids  jsonb not null default '[]',
  stage_plan            jsonb,           -- final stages decided, if big task
  credits_used          integer,         -- 1 for small; 2 + stage count for big (see usage_limits)
  status                text not null default 'in_progress'
                        check (status in ('in_progress','completed','abandoned')),
  created_at            timestamptz not null default now(),
  completed_at          timestamptz,
  constraint one_owner check (
    (anon_session_id is not null and user_id is null) or
    (anon_session_id is null and user_id is not null)
  )
);

create index idx_sessions_anon on interview_sessions (anon_session_id);
create index idx_sessions_user on interview_sessions (user_id);

-- =========================================================
-- Usage events — lightweight cost/observability log, one row
-- per model call so spend is traceable to a specific step+model.
-- =========================================================
create table usage_events (
  id              bigint generated always as identity primary key,
  session_id      uuid references interview_sessions(id),
  step            text not null check (step in ('classify','select_question','plan_stages','generate')),
  model           text not null,         -- e.g. 'claude-haiku-4-5', 'claude-sonnet-4-6'
  input_tokens    integer,
  output_tokens   integer,
  created_at      timestamptz not null default now()
);

create index idx_usage_session on usage_events (session_id);

-- =========================================================
-- Feedback — the proxy signal for "did this actually work,"
-- since there's no way to see what happens after the user
-- copies the prompt and leaves the app.
-- =========================================================
create table feedback (
  id          bigint generated always as identity primary key,
  session_id  uuid references interview_sessions(id) not null,
  rating      text not null check (rating in ('up','down')),
  comment     text,
  created_at  timestamptz not null default now()
);

-- =========================================================
-- Prompt library — curated strong examples for future few-shot
-- grounding of the generator step. Starts empty; populate over time.
-- =========================================================
create table prompt_library (
  id              uuid primary key default gen_random_uuid(),
  category        text not null,
  destination     text,
  example_request text not null,
  example_output  text not null,
  quality_score   integer,               -- manually curated, 1-5
  added_at        timestamptz not null default now()
);

-- =========================================================
-- EXAMPLE SEED DATA — illustrative, matching the three checklists
-- already drafted in design discussion (writing, financial_model, code).
-- =========================================================

insert into checklist_questions (id, category, priority, text, input_type, options, hint) values
('writing.audience', 'writing', 1,
  'Who''s going to read this?',
  'single_select',
  '[{"label":"Coworkers and people in your industry"},{"label":"Your customers"},{"label":"People who don''t know your company yet"}]',
  null),
('writing.feel', 'writing', 2,
  'Pick whichever line sounds closest to how you''d want it to feel:',
  'single_select',
  '[{"label":"Polished and confident","example":"We''re proud to introduce our newest solution for enterprise teams"},{"label":"Warm and energetic","example":"We just launched something we''re really excited about!"},{"label":"Calm and straightforward","example":"Here''s what we built, and why"}]',
  null),
('writing.length', 'writing', 3,
  'How much should it say?',
  'single_select',
  '[{"label":"A couple of quick sentences"},{"label":"A short paragraph"},{"label":"Several paragraphs with more detail"}]',
  null),
('writing.cta', 'writing', 4,
  'Should it end by asking people to do something specific?',
  'single_select',
  '[{"label":"Yes — visit a link, sign up, or comment"},{"label":"No, just share the news"}]',
  null);

insert into checklist_questions (id, category, priority, text, input_type, options, hint) values
('financial_model.purpose', 'financial_model', 1,
  'What''s this model actually for?',
  'single_select',
  '[{"label":"Convincing investors to fund something"},{"label":"Planning your own budget"},{"label":"Helping you decide between a couple of options"}]',
  null),
('financial_model.horizon', 'financial_model', 2,
  'How far ahead should it look?',
  'single_select',
  '[{"label":"The next 12 months"},{"label":"The next 3 to 5 years"},{"label":"Longer-term"}]',
  null),
('financial_model.numbers', 'financial_model', 3,
  'Do you already have real numbers in mind, or should typical-for-your-industry numbers be used as a starting point?',
  'single_select',
  '[{"label":"I have real numbers"},{"label":"Use sensible placeholder numbers"}]',
  'This decides whether the model uses your real figures or placeholders you can swap in later.'),
('financial_model.detail', 'financial_model', 4,
  'Do you want big-picture numbers only, or a detailed, line-by-line breakdown?',
  'single_select',
  '[{"label":"Big picture only"},{"label":"Detailed line-by-line breakdown"}]',
  null),
('financial_model.audience', 'financial_model', 5,
  'Is anyone specific going to be looking at this and judging it?',
  'single_select',
  '[{"label":"A bank, investor, or business partner"},{"label":"No, mainly for my own planning"}]',
  null);

insert into checklist_questions (id, category, priority, text, input_type, options, hint) values
('code.language', 'code', 1,
  'Do you already know what language or tool this should be in?',
  'single_select',
  '[{"label":"I have one in mind"},{"label":"Not sure — suggest something simple"}]',
  null),
('code.example', 'code', 2,
  'Give one real example: if you fed this some sample input, what would you want back?',
  'free_text',
  null,
  null),
('code.usage', 'code', 3,
  'Is this something you''ll run once, or use repeatedly over time?',
  'single_select',
  '[{"label":"Just once"},{"label":"I''ll reuse this regularly"},{"label":"Not sure"}]',
  null),
('code.edge_cases', 'code', 4,
  'Are there messy situations it should handle gracefully instead of breaking?',
  'multi_select',
  '[{"label":"Blank entries"},{"label":"Weird formatting"},{"label":"Duplicates"},{"label":"Not sure, just handle obvious problems sensibly"}]',
  null),
('code.integration', 'code', 5,
  'Does it need to connect to anything you already have?',
  'single_select',
  '[{"label":"Yes, a specific spreadsheet, website, app, or database"},{"label":"No, it stands alone"}]',
  null);

insert into stage_templates (id, category, order_index, title, purpose, trigger_rule) values
('financial_model.structure', 'financial_model', 1,
  'Structure and assumptions',
  'Establish the model''s layout and the assumptions everything else will build on.',
  '{"always": true}'),
('financial_model.detail_buildout', 'financial_model', 2,
  'Full detailed build-out',
  'Expand the structure into a complete, line-by-line model.',
  '{"question_id":"financial_model.detail","include_if_in":["Detailed line-by-line breakdown"]}'),
('financial_model.sanity_check', 'financial_model', 3,
  'Sanity-check the numbers',
  'Review the model for internal consistency before it''s used.',
  '{"always": true}'),
('financial_model.investor_framing', 'financial_model', 4,
  'Investor-ready framing',
  'Polish the narrative and presentation for an external, judging audience.',
  '{"question_id":"financial_model.audience","include_if_in":["A bank, investor, or business partner"]}');

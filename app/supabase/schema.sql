-- LEGACY: this Supabase schema is no longer used. Sync now goes through the Encore API (../jivvy-life-api). Kept for reference only.
-- Life App Alpha v1 — Supabase Postgres Schema
-- Paste this into your Supabase SQL Editor and run once.

create extension if not exists "pgcrypto";

-- 1. Workspaces & Tabs Manifest
create table if not exists public.workspaces (
  id text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  context_tag text not null default 'personal',
  layout text not null default 'single',
  primary_tab_id text,
  secondary_tab_id text,
  tabs jsonb not null default '[]'::jsonb,
  folders jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
-- For databases created before folders existed:
alter table public.workspaces add column if not exists folders jsonb not null default '[]'::jsonb;

-- 2. Native Markdown Notes
create table if not exists public.notes (
  id text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  content text not null default '',
  tags text[] not null default '{}',
  wikilinks text[] not null default '{}',
  context_id text,
  updated_at timestamptz not null default now()
);

-- 3. Device & UI Preferences (Layout Mode, Sidebar Width, Theme)
create table if not exists public.user_preferences (
  device_id text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  layout_mode text not null default 'left-vertical',
  sidebar_width integer not null default 260,
  updated_at timestamptz not null default now()
);

-- 4. Honest Mirror Telemetry Events (Idle-Gated & Context-Linked)
create table if not exists public.telemetry_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  device_id text not null default 'laptop_primary',
  event_type text not null, -- tab_focused, transition, idle_start, idle_end, verified_outcome
  activity_context_id text,
  workspace_id text,
  tab_id text,
  domain text,
  duration_seconds integer default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 5. Daily Deterministic Rollups
create table if not exists public.daily_metrics (
  date date not null,
  user_id uuid references auth.users(id) on delete cascade,
  active_minutes integer not null default 0,
  context_switches integer not null default 0,
  verified_outcomes integer not null default 0,
  breakdown jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (date, user_id)
);

-- Enable Row Level Security (RLS)
alter table public.workspaces enable row level security;
alter table public.notes enable row level security;
alter table public.user_preferences enable row level security;
alter table public.telemetry_events enable row level security;
alter table public.daily_metrics enable row level security;

-- Alpha Testing Policies (Supports authenticated users; tighten for production)
create policy "Users manage own workspaces" on public.workspaces
  for all using (auth.uid() = user_id or user_id is null);
create policy "Users manage own notes" on public.notes
  for all using (auth.uid() = user_id or user_id is null);
create policy "Users manage own preferences" on public.user_preferences
  for all using (auth.uid() = user_id or user_id is null);
create policy "Users manage own telemetry" on public.telemetry_events
  for all using (auth.uid() = user_id or user_id is null);
create policy "Users manage own daily_metrics" on public.daily_metrics
  for all using (auth.uid() = user_id or user_id is null);

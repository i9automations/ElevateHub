create extension if not exists citext;

create table if not exists public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email citext not null unique,
  role text not null default 'operator' check (role in ('admin', 'operator')),
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id text primary key,
  name text not null,
  tiktok_email citext unique,
  mailbox_email citext,
  squad text not null default 'fox',
  start_url text not null default 'https://seller-br.tiktok.com/account/login',
  notes text not null default '',
  tags text[] not null default '{}',
  session_state text not null default 'empty',
  locked_by uuid references public.app_users(id) on delete set null,
  locked_at timestamptz,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists squad text not null default 'fox',
  add column if not exists start_url text not null default 'https://seller-br.tiktok.com/account/login';

update public.profiles
set
  squad = coalesce(nullif(squad, ''), 'fox'),
  start_url = coalesce(nullif(start_url, ''), 'https://seller-br.tiktok.com/account/login');

create table if not exists public.audit (
  id text primary key,
  at timestamptz not null default now(),
  user_id uuid references public.app_users(id) on delete set null,
  user_name text not null default 'sistema',
  action text not null,
  target_id text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists profiles_name_idx on public.profiles using btree (name);
create index if not exists profiles_squad_idx on public.profiles using btree (squad);
create index if not exists profiles_session_state_idx on public.profiles using btree (session_state);
create index if not exists profiles_locked_by_idx on public.profiles using btree (locked_by);
create index if not exists audit_at_idx on public.audit using btree (at desc);
create index if not exists audit_action_idx on public.audit using btree (action);

alter table public.app_users enable row level security;
alter table public.profiles enable row level security;
alter table public.audit enable row level security;

-- A API da VPS usa a service role key e ignora RLS. As politicas abaixo deixam
-- leitura segura pelo cliente no futuro, caso o desktop passe a falar direto com Supabase.
drop policy if exists app_users_read_self on public.app_users;
create policy app_users_read_self on public.app_users
  for select
  using (auth.uid() = id);

drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles
  for select
  using (auth.role() = 'authenticated');

drop policy if exists audit_read_authenticated on public.audit;
create policy audit_read_authenticated on public.audit
  for select
  using (auth.role() = 'authenticated');

-- Depois de criar o primeiro usuario no Supabase Auth, rode algo assim:
--
-- insert into public.app_users (id, name, email, role)
-- select id, 'Admin', email, 'admin'
-- from auth.users
-- where email = 'admin@elevateecom.com.br'
-- on conflict (id) do update set role = 'admin', name = excluded.name;

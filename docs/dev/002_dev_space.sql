-- 002_dev_space.sql — berelax.space/dev geliştirici alanı
-- Supabase Dashboard → SQL Editor'a yapıştırıp bir kez çalıştır.
-- Yeniden çalıştırmak güvenli (if not exists / drop policy if exists).
--
-- Model:
--   dev_private.members  geliştirici listesi; istemciden görünmez, yalnız
--                        /api/dev-signup (service role) yazar.
--   public.dev_notes     geliştirici notları; yalnız üyeler okur/yazar.
--   public.dev_state     kişiye özel kalıcı veri (ör. günlük seçim kuyruğu).
-- Normal site hesapları (Google ile giriş) bu tablolara erişemez.

begin;

create schema if not exists dev_private;
revoke all on schema dev_private from public, anon, authenticated;

create table if not exists dev_private.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,24}$'),
  created_at timestamptz not null default now()
);
revoke all on dev_private.members from public, anon, authenticated;

create or replace function public.is_dev_member()
returns boolean language sql stable security definer
set search_path = ''
as $$ select exists (select 1 from dev_private.members where user_id = (select auth.uid())) $$;
revoke all on function public.is_dev_member() from public, anon;
grant execute on function public.is_dev_member() to authenticated;

create or replace function public.dev_username()
returns text language sql stable security definer
set search_path = ''
as $$ select username from dev_private.members where user_id = (select auth.uid()) $$;
revoke all on function public.dev_username() from public, anon;
grant execute on function public.dev_username() to authenticated;

-- Kayıt kapısı: ilk geliştirici hesabı açılınca kayıt kendiliğinden kapanır.
create or replace function public.dev_member_count()
returns bigint language sql stable security definer
set search_path = ''
as $$ select count(*) from dev_private.members $$;
revoke all on function public.dev_member_count() from public, anon, authenticated;
grant execute on function public.dev_member_count() to service_role;

create or replace function public.dev_add_member(p_user_id uuid, p_username text)
returns void language sql volatile security definer
set search_path = ''
as $$ insert into dev_private.members (user_id, username) values (p_user_id, p_username) $$;
revoke all on function public.dev_add_member(uuid, text) from public, anon, authenticated;
grant execute on function public.dev_add_member(uuid, text) to service_role;

create table if not exists public.dev_notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author text not null default public.dev_username(),
  screen text not null check (char_length(screen) between 1 and 80),
  body text not null check (char_length(body) between 1 and 4000),
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists dev_notes_created_idx on public.dev_notes (created_at desc);
alter table public.dev_notes enable row level security;
revoke all on public.dev_notes from anon;
grant select, insert on public.dev_notes to authenticated;
drop policy if exists dev_notes_read on public.dev_notes;
create policy dev_notes_read on public.dev_notes for select to authenticated
  using ((select public.is_dev_member()));
drop policy if exists dev_notes_write on public.dev_notes;
create policy dev_notes_write on public.dev_notes for insert to authenticated
  with check (author_id = (select auth.uid()) and (select public.is_dev_member()));

create table if not exists public.dev_state (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 80),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.dev_state enable row level security;
revoke all on public.dev_state from anon;
grant select, insert, update on public.dev_state to authenticated;
drop policy if exists dev_state_own on public.dev_state;
create policy dev_state_own on public.dev_state for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_dev_member()))
  with check (user_id = (select auth.uid()) and (select public.is_dev_member()));

commit;

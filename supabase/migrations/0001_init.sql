-- Gavelisten: initial schema.
--
-- Model: a user (auth.users + public.profiles) can be a member of several
-- groups. Every person card and every wish belongs to exactly one group, and
-- every member of that group may read and change all of it. The only admin
-- rights are on the group itself: the owner can rename it, regenerate the
-- invite token and remove members.
--
-- Security notes:
--   * RLS is enabled on every table. Policies call SECURITY DEFINER helpers
--     (is_member, is_owner, shares_group) so that a policy on group_members
--     does not have to query group_members through RLS again (recursion).
--   * All SECURITY DEFINER functions pin search_path to '' and use fully
--     qualified names, so a caller cannot shadow tables or functions.
--   * Table privileges are granted per column. Clients can never write ids,
--     group_id on update, created_by, bought_by, bought_at or owner_id
--     directly; defaults and triggers fill those in.
--   * Groups and memberships are created only through the create_group and
--     join_group RPCs.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
               check (char_length(display_name) between 1 and 60 and btrim(display_name) <> ''),
  created_at   timestamptz not null default now()
);

create table public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null
               check (char_length(name) between 1 and 60 and btrim(name) <> ''),
  -- 18 random bytes = 144 bits, hex encoded. Only members can read it (RLS on groups).
  invite_token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  -- Nullable: if the owner's account is deleted the column is cleared and the
  -- member-removed trigger hands ownership to the longest-standing member.
  owner_id     uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.groups (id) on delete cascade,
  -- References profiles (not auth.users directly) so every member has a name.
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_id_idx on public.group_members (user_id);

create table public.people (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  name       text not null
             check (char_length(name) between 1 and 60 and btrim(name) <> ''),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  -- Target for the composite foreign key from wishes, see below.
  unique (id, group_id)
);
create index people_group_id_idx on public.people (group_id);

create table public.wishes (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  person_id  uuid not null,
  title      text not null
             check (char_length(title) between 1 and 200 and btrim(title) <> ''),
  link       text not null default ''
             check (char_length(link) <= 2000 and (link = '' or link ~* '^https?://')),
  price      text not null default '' check (char_length(price) <= 60),
  note       text not null default '' check (char_length(note) <= 300),
  bought     boolean not null default false,
  bought_by  uuid references public.profiles (id) on delete set null,
  bought_at  timestamptz,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Composite key: the wish's person must live in the same group as the wish.
  -- Deleting a person deletes their wishes.
  foreign key (person_id, group_id) references public.people (id, group_id) on delete cascade
);
create index wishes_group_id_idx on public.wishes (group_id);
create index wishes_person_group_idx on public.wishes (person_id, group_id);

-- ---------------------------------------------------------------------------
-- Helper functions used by policies
-- ---------------------------------------------------------------------------
-- These return false for anonymous callers instead of raising, because they
-- run inside policies where an exception would turn every read into an error.

create or replace function public.is_member(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_owner(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.groups g
    where g.id = gid and g.owner_id = auth.uid()
  );
$$;

-- True when the caller and other_user are both members of at least one group.
create or replace function public.shares_group(other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid() and theirs.user_id = other_user
  );
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function public.create_group(group_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  clean text := btrim(coalesce(group_name, ''));
  gid   uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if char_length(clean) not between 1 and 60 then
    raise exception 'invalid group name' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = uid) then
    raise exception 'profile required' using errcode = 'P0001';
  end if;

  insert into public.groups (name, owner_id) values (clean, uid) returning id into gid;
  insert into public.group_members (group_id, user_id) values (gid, uid);
  return gid;
end;
$$;

create or replace function public.join_group(token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  gid uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles p where p.id = uid) then
    raise exception 'profile required' using errcode = 'P0001';
  end if;
  if token is null or char_length(token) > 100 then
    raise exception 'invalid invite' using errcode = 'P0002';
  end if;

  select g.id into gid from public.groups g where g.invite_token = token;
  if gid is null then
    raise exception 'invalid invite' using errcode = 'P0002';
  end if;

  insert into public.group_members (group_id, user_id) values (gid, uid)
  on conflict do nothing;
  return gid;
end;
$$;

create or replace function public.regenerate_invite(gid uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid       uuid := auth.uid();
  new_token text;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update public.groups g
     set invite_token = encode(extensions.gen_random_bytes(18), 'hex')
   where g.id = gid and g.owner_id = uid
  returning g.invite_token into new_token;

  if new_token is null then
    raise exception 'only the group owner can do this' using errcode = '42501';
  end if;
  return new_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- When a membership disappears (leave, removal by owner, account deletion):
--   * the last member leaving deletes the group and all its lists, so no
--     orphaned data is left that nobody can reach;
--   * if the owner left, ownership passes to the longest-standing member.
-- SECURITY DEFINER because the leaving member may not be allowed to update
-- groups. It does not require auth.uid(), because it also runs when an
-- administrator deletes a user and the delete cascades here.
create or replace function public.handle_member_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_owner uuid;
begin
  select m.user_id into next_owner
    from public.group_members m
   where m.group_id = old.group_id
   order by m.joined_at, m.user_id
   limit 1;

  if next_owner is null then
    delete from public.groups g where g.id = old.group_id;
  else
    update public.groups g
       set owner_id = next_owner
     where g.id = old.group_id
       and (g.owner_id = old.user_id or g.owner_id is null);
  end if;
  return null;
end;
$$;

create trigger group_members_after_delete
  after delete on public.group_members
  for each row execute function public.handle_member_removed();

-- The server, not the client, decides who bought a wish and when. Ticking
-- "Kjøpt" records the caller and the current time; unticking clears both.
-- Changing bought_by or bought_at on an already bought wish is ignored
-- (except clearing bought_by, which the profiles foreign key does on delete).
-- Not SECURITY DEFINER: it only reads auth.uid() and touches NEW.
create or replace function public.wishes_set_bought()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not new.bought then
    new.bought_by := null;
    new.bought_at := null;
  elsif tg_op = 'INSERT' or not old.bought then
    new.bought_by := auth.uid();
    new.bought_at := now();
  else
    if new.bought_by is not null and new.bought_by is distinct from old.bought_by then
      new.bought_by := old.bought_by;
    end if;
    if new.bought_at is distinct from old.bought_at then
      new.bought_at := old.bought_at;
    end if;
  end if;
  return new;
end;
$$;

create trigger wishes_before_write
  before insert or update on public.wishes
  for each row execute function public.wishes_set_bought();

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public.is_member(uuid),
  public.is_owner(uuid),
  public.shares_group(uuid),
  public.create_group(text),
  public.join_group(text),
  public.regenerate_invite(uuid),
  public.handle_member_removed(),
  public.wishes_set_bought()
from public, anon;

grant execute on function
  public.is_member(uuid),
  public.is_owner(uuid),
  public.shares_group(uuid),
  public.create_group(text),
  public.join_group(text),
  public.regenerate_invite(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges (column level, least privilege)
-- ---------------------------------------------------------------------------

revoke all on public.profiles, public.groups, public.group_members, public.people, public.wishes
  from anon, authenticated;

grant select on public.profiles, public.groups, public.group_members, public.people, public.wishes
  to authenticated;

grant insert (id, display_name), update (display_name) on public.profiles to authenticated;
grant update (name) on public.groups to authenticated;
grant delete on public.group_members to authenticated;
grant insert (group_id, name, sort_order), update (name, sort_order), delete
  on public.people to authenticated;
grant insert (group_id, person_id, title, link, price, note, bought),
      update (title, link, price, note, bought),
      delete
  on public.wishes to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.people        enable row level security;
alter table public.wishes        enable row level security;

-- profiles: readable by yourself and by anyone you share a group with;
-- writable only by yourself. No delete policy: profiles go away with the
-- auth user (on delete cascade).
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_group(id));

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- groups: members can read (this is what keeps invite_token private);
-- the owner can rename. Insert only via create_group; no client deletes.
create policy groups_select on public.groups
  for select to authenticated
  using (public.is_member(id));

create policy groups_update on public.groups
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- group_members: members see the member list of their groups. A member can
-- delete their own row (leave); the owner can delete anyone's (remove).
-- Insert only via create_group / join_group.
create policy group_members_select on public.group_members
  for select to authenticated
  using (public.is_member(group_id));

create policy group_members_delete on public.group_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_owner(group_id));

-- people and wishes: any member can do anything within their groups.
create policy people_select on public.people
  for select to authenticated using (public.is_member(group_id));
create policy people_insert on public.people
  for insert to authenticated with check (public.is_member(group_id));
create policy people_update on public.people
  for update to authenticated
  using (public.is_member(group_id)) with check (public.is_member(group_id));
create policy people_delete on public.people
  for delete to authenticated using (public.is_member(group_id));

create policy wishes_select on public.wishes
  for select to authenticated using (public.is_member(group_id));
create policy wishes_insert on public.wishes
  for insert to authenticated with check (public.is_member(group_id));
create policy wishes_update on public.wishes
  for update to authenticated
  using (public.is_member(group_id)) with check (public.is_member(group_id));
create policy wishes_delete on public.wishes
  for delete to authenticated using (public.is_member(group_id));

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- The client listens for changes filtered on group_id and refetches. Realtime
-- applies the select policies above before delivering INSERT and UPDATE
-- events. DELETE events carry only the primary key and cannot be filtered, so
-- every subscriber sees that "some row was deleted" and simply refetches.

alter publication supabase_realtime add table public.people, public.wishes, public.group_members;

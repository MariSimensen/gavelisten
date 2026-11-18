-- Gavelisten v3: quantities, purchases per person, images and edit locks.
--
-- Runs after 0001_init.sql. Written to be safe to run more than once where
-- that was easy (if not exists, do blocks, drop policy if exists).
--
-- What it adds:
--   * wishes.quantity (1 to 99) and wishes.image_path.
--   * wishes.person_id becomes updatable, so a wish can move to another
--     person. The composite foreign key from 0001 keeps it in the same group.
--   * wish_purchases: how many of a wish each member has bought, for wishes
--     with a quantity above 1. A trigger refuses buying more than wanted.
--   * wish_locks: who is editing a wish right now. Only written through the
--     acquire/renew/release RPCs, which are atomic and expire after 8 minutes.
--   * A private Storage bucket "wish-images" with object policies so only
--     members of the group in the first path segment can read, add or delete.
--
-- Same security rules as 0001: RLS on every table, column level grants,
-- SECURITY DEFINER functions with search_path pinned to ''.

-- ---------------------------------------------------------------------------
-- wishes: quantity, image, movable between people
-- ---------------------------------------------------------------------------

alter table public.wishes add column if not exists quantity integer not null default 1;
alter table public.wishes add column if not exists image_path text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wishes_quantity_check' and conrelid = 'public.wishes'::regclass) then
    alter table public.wishes add constraint wishes_quantity_check check (quantity between 1 and 99);
  end if;
  -- An image must live in the wish's own group folder: "<group_id>/<uuid>.jpg".
  -- Storage policies already stop reading other groups' files; this keeps the
  -- data tidy and the paths predictable.
  if not exists (select 1 from pg_constraint where conname = 'wishes_image_path_check' and conrelid = 'public.wishes'::regclass) then
    alter table public.wishes add constraint wishes_image_path_check check (
      image_path = ''
      or (left(image_path, 37) = group_id::text || '/'
          and image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$')
    );
  end if;
  -- Target for the composite foreign keys from wish_purchases and wish_locks,
  -- so their group_id always matches the wish's group.
  if not exists (select 1 from pg_constraint where conname = 'wishes_id_group_id_key' and conrelid = 'public.wishes'::regclass) then
    alter table public.wishes add constraint wishes_id_group_id_key unique (id, group_id);
  end if;
end $$;

-- person_id is now updatable ("Ønske til"). The foreign key
-- (person_id, group_id) -> people (id, group_id) rejects a person from
-- another group, and group_id itself stays non-updatable.
grant insert (quantity, image_path), update (person_id, quantity, image_path)
  on public.wishes to authenticated;

-- ---------------------------------------------------------------------------
-- wish_purchases
-- ---------------------------------------------------------------------------

create table if not exists public.wish_purchases (
  wish_id  uuid not null,
  user_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  n        integer not null check (n between 1 and 99),
  at       timestamptz not null default now(),
  primary key (wish_id, user_id),
  foreign key (wish_id, group_id) references public.wishes (id, group_id) on delete cascade
);
create index if not exists wish_purchases_group_id_idx on public.wish_purchases (group_id);

-- Sets "at" on the server and refuses a purchase that would make the total
-- bought exceed the wish's quantity. A wish ticked with the single "Kjøpt"
-- checkbox (bought = true) counts as one bought item, so a wish that was
-- bought before its quantity was raised keeps that purchase.
-- Decreasing your own number is always allowed, also when the quantity has
-- since been lowered below what was already bought.
-- SECURITY DEFINER so the sum sees every member's rows and can lock the wish
-- row (FOR UPDATE), which makes two simultaneous purchases wait for each other.
create or replace function public.wish_purchases_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  q      integer;
  b      boolean;
  others integer;
begin
  new.at := now();
  if tg_op = 'UPDATE' and new.n <= old.n then
    return new;
  end if;
  -- BEFORE triggers run before the RLS check. Let RLS reject non-members,
  -- so this function never tells an outsider anything about a wish.
  if not public.is_member(new.group_id) then
    return new;
  end if;

  select w.quantity, w.bought into q, b
    from public.wishes w
   where w.id = new.wish_id and w.group_id = new.group_id
   for update;
  if not found then
    return new; -- the foreign key reports the error
  end if;

  select coalesce(sum(p.n), 0) into others
    from public.wish_purchases p
   where p.wish_id = new.wish_id and p.user_id <> new.user_id;

  if others + new.n + (case when b then 1 else 0 end) > q then
    raise exception 'more than the wanted quantity' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists wish_purchases_before_write on public.wish_purchases;
create trigger wish_purchases_before_write
  before insert or update on public.wish_purchases
  for each row execute function public.wish_purchases_before_write();

-- The other direction: ticking "Kjøpt" is refused when the purchases already
-- cover the whole quantity.
create or replace function public.wishes_check_bought_quantity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bought_items integer;
begin
  if new.bought and (tg_op = 'INSERT' or not old.bought) then
    select coalesce(sum(p.n), 0) into bought_items
      from public.wish_purchases p where p.wish_id = new.id;
    if bought_items + 1 > new.quantity then
      raise exception 'more than the wanted quantity' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists wishes_check_bought_quantity on public.wishes;
create trigger wishes_check_bought_quantity
  before insert or update of bought on public.wishes
  for each row execute function public.wishes_check_bought_quantity();

alter table public.wish_purchases enable row level security;

revoke all on public.wish_purchases from anon, authenticated;
grant select on public.wish_purchases to authenticated;
-- user_id is not client writable: it defaults to auth.uid(). "at" is set by
-- the trigger. Only n can change after insert.
grant insert (wish_id, group_id, n), update (n), delete on public.wish_purchases to authenticated;

drop policy if exists wish_purchases_select on public.wish_purchases;
create policy wish_purchases_select on public.wish_purchases
  for select to authenticated using (public.is_member(group_id));

drop policy if exists wish_purchases_insert on public.wish_purchases;
create policy wish_purchases_insert on public.wish_purchases
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_member(group_id));

drop policy if exists wish_purchases_update on public.wish_purchases;
create policy wish_purchases_update on public.wish_purchases
  for update to authenticated
  using (user_id = (select auth.uid()) and public.is_member(group_id))
  with check (user_id = (select auth.uid()) and public.is_member(group_id));

drop policy if exists wish_purchases_delete on public.wish_purchases;
create policy wish_purchases_delete on public.wish_purchases
  for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_member(group_id));

-- ---------------------------------------------------------------------------
-- wish_locks
-- ---------------------------------------------------------------------------

create table if not exists public.wish_locks (
  wish_id    uuid primary key,
  group_id   uuid not null references public.groups (id) on delete cascade,
  locked_by  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  tab        text not null default '' check (char_length(tab) <= 64),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Deleting the wish removes its lock.
  foreign key (wish_id, group_id) references public.wishes (id, group_id) on delete cascade
);
create index if not exists wish_locks_group_id_idx on public.wish_locks (group_id);

alter table public.wish_locks enable row level security;

-- Members can see who is editing. Nobody writes the table directly; the RPCs
-- below do, so a lock can only be taken when it is free, expired or yours.
revoke all on public.wish_locks from anon, authenticated;
grant select on public.wish_locks to authenticated;

drop policy if exists wish_locks_select on public.wish_locks;
create policy wish_locks_select on public.wish_locks
  for select to authenticated using (public.is_member(group_id));

-- Takes or extends the lock on a wish. Atomic (one INSERT ... ON CONFLICT):
-- succeeds when there is no lock, the lock has expired, or the caller
-- already holds it (any tab; the newest tab is recorded). Otherwise returns
-- ok = false with the holder. A lock lasts 8 minutes from the last call; the
-- page closes the editor after 7 minutes without activity, and renews on
-- activity at most every 30 seconds, so a lock never expires under an
-- active editor.
create or replace function public.acquire_wish_lock(wid uuid, tab text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid  uuid := auth.uid();
  gid  uuid;
  clean_tab text := left(coalesce(tab, ''), 64);
  got  public.wish_locks%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select w.group_id into gid from public.wishes w where w.id = wid;
  if gid is null or not public.is_member(gid) then
    raise exception 'no such wish' using errcode = '42501';
  end if;

  insert into public.wish_locks as l (wish_id, group_id, locked_by, tab, started_at, expires_at)
  values (wid, gid, uid, clean_tab, now(), now() + interval '8 minutes')
  on conflict (wish_id) do update
     set locked_by  = excluded.locked_by,
         tab        = excluded.tab,
         started_at = case when l.locked_by = excluded.locked_by and l.expires_at > now()
                           then l.started_at else now() end,
         expires_at = excluded.expires_at
   where l.locked_by = excluded.locked_by or l.expires_at <= now()
  returning l.* into got;

  if got.wish_id is not null then
    return jsonb_build_object('ok', true, 'locked_by', got.locked_by, 'tab', got.tab,
                              'expires_at', got.expires_at, 'server_now', now());
  end if;

  select * into got from public.wish_locks l where l.wish_id = wid;
  return jsonb_build_object('ok', false, 'locked_by', got.locked_by, 'tab', got.tab,
                            'expires_at', got.expires_at, 'server_now', now());
end;
$$;

-- Renewing is the same atomic operation; the separate name keeps the client
-- code readable.
create or replace function public.renew_wish_lock(wid uuid, tab text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.acquire_wish_lock(wid, tab);
$$;

-- Releases the caller's lock, but only the one taken from this tab, so
-- closing one tab does not free a lock another of your tabs took over.
create or replace function public.release_wish_lock(wid uuid, tab text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.wish_locks l
   where l.wish_id = wid and l.locked_by = auth.uid() and l.tab = left(coalesce(tab, ''), 64);
$$;

revoke execute on function
  public.wish_purchases_before_write(),
  public.wishes_check_bought_quantity(),
  public.acquire_wish_lock(uuid, text),
  public.renew_wish_lock(uuid, text),
  public.release_wish_lock(uuid, text)
from public, anon;

grant execute on function
  public.acquire_wish_lock(uuid, text),
  public.renew_wish_lock(uuid, text),
  public.release_wish_lock(uuid, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for wish images
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wish-images', 'wish-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- True when the first folder of an object name is a group the caller is a
-- member of. Parses the folder safely, so a name that is not a uuid gives
-- false instead of a cast error inside a policy.
create or replace function public.is_member_of_folder(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  folder text := (storage.foldername(object_name))[1];
begin
  if folder is null or folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_member(folder::uuid);
end;
$$;

revoke execute on function public.is_member_of_folder(text) from public, anon;
grant execute on function public.is_member_of_folder(text) to authenticated;

-- Objects are "<group_id>/<uuid>.jpg". No update policy: images are never
-- overwritten, a replaced image gets a new name and the old one is deleted.
drop policy if exists wish_images_select on storage.objects;
create policy wish_images_select on storage.objects
  for select to authenticated
  using (bucket_id = 'wish-images' and public.is_member_of_folder(name));

drop policy if exists wish_images_insert on storage.objects;
create policy wish_images_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'wish-images'
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
    and public.is_member_of_folder(name)
  );

drop policy if exists wish_images_delete on storage.objects;
create policy wish_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'wish-images' and public.is_member_of_folder(name));

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wish_purchases') then
    alter publication supabase_realtime add table public.wish_purchases;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wish_locks') then
    alter publication supabase_realtime add table public.wish_locks;
  end if;
end $$;

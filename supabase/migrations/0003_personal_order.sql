-- Gavelisten: personal order of the people (name chips and cards).
--
-- Runs after 0002_v3.sql. Safe to run more than once.
--
-- Each member can drag the name chips into their own order. The order is
-- stored per user, so it follows them across devices and does not change
-- what the others see. people.sort_order stays as the shared starting order:
-- it is used for anyone who has not sorted yet, and for people added later
-- (they go after the ones the user has placed).
--
-- Same security rules as before: RLS on the table, column level grants, and a
-- user can only ever see or change their own rows, in groups they belong to.

create table if not exists public.person_order (
  user_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  person_id uuid not null,
  group_id  uuid not null,
  position  integer not null check (position between 1 and 10000),
  primary key (user_id, person_id),
  -- The person must live in the given group. Deleting the person removes the row.
  foreign key (person_id, group_id) references public.people (id, group_id) on delete cascade
);
create index if not exists person_order_group_user_idx on public.person_order (group_id, user_id);

alter table public.person_order enable row level security;

revoke all on public.person_order from anon, authenticated;
grant select, delete on public.person_order to authenticated;
-- user_id is not client writable: it defaults to auth.uid(). The update grant
-- covers the columns an upsert (insert ... on conflict do update) sets.
grant insert (person_id, group_id, position), update (person_id, group_id, position) on public.person_order to authenticated;

drop policy if exists person_order_select on public.person_order;
create policy person_order_select on public.person_order
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_member(group_id));

drop policy if exists person_order_insert on public.person_order;
create policy person_order_insert on public.person_order
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_member(group_id));

drop policy if exists person_order_update on public.person_order;
create policy person_order_update on public.person_order
  for update to authenticated
  using (user_id = (select auth.uid()) and public.is_member(group_id))
  with check (user_id = (select auth.uid()) and public.is_member(group_id));

drop policy if exists person_order_delete on public.person_order;
create policy person_order_delete on public.person_order
  for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_member(group_id));

-- Realtime: a change on one device shows up on the user's other devices.
-- Realtime applies the select policy, so nobody receives other people's rows.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'person_order') then
    alter publication supabase_realtime add table public.person_order;
  end if;
end $$;

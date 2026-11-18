-- RLS and RPC checks for supabase/migrations/0001_init.sql.
--
-- Run against a local Supabase database that has the migration applied, for
-- example:
--   supabase start && supabase db reset
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f tests/rls.sql
--
-- Runs as a superuser, switches to the "authenticated" role and fakes the
-- JWT the same way PostgREST does (request.jwt.claims). Any failed check
-- raises an exception. Everything happens in one transaction that is rolled
-- back at the end, so no test data is left behind.

begin;

-- Test users
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob@example.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'carol@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'dave@example.test');

create temporary table ids (k text primary key, v text);
grant all on ids to authenticated;

-- Small assertion helper usable from any role.
create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

-- Expect a statement to fail with a given SQLSTATE.
create function pg_temp.expect_error(stmt text, state text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'FAILED (no error): %', msg;
exception when others then
  if sqlstate like 'FAILED%' or sqlerrm like 'FAILED (no error)%' then raise; end if;
  if sqlstate <> state then raise exception 'FAILED (got % "%" instead of %): %', sqlstate, sqlerrm, state, msg; end if;
end $$;
grant execute on function pg_temp.expect_error(text, text, text) to authenticated, anon;

-- ---------------------------------------------------------------- alice
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;

select pg_temp.expect_error($$ select public.create_group('Ingen profil') $$, 'P0001', 'create_group needs a profile');
select pg_temp.expect_error(
  $$ insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-0000000000b2', 'Falsk Bob') $$,
  '42501', 'cannot create a profile for someone else');
insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-0000000000a1', 'Alice');
select pg_temp.expect_error($$ insert into public.profiles (id, display_name) values (auth.uid(), '') $$, '23514', 'empty display name rejected');

insert into ids select 'g1', public.create_group('  Familien  ')::text;
select pg_temp.check((select name from public.groups where id = (select v::uuid from ids where k = 'g1')) = 'Familien', 'group name trimmed');
select pg_temp.check((select owner_id from public.groups where id = (select v::uuid from ids where k = 'g1')) = auth.uid(), 'creator is owner');
select pg_temp.check((select count(*) from public.group_members where user_id = auth.uid()) = 1, 'creator is member');
select pg_temp.expect_error($$ select public.create_group('') $$, '22023', 'empty group name rejected');
select pg_temp.expect_error(
  $$ insert into public.groups (name, owner_id) values ('Direkte', auth.uid()) $$, '42501', 'no direct insert into groups');

insert into public.people (group_id, name, sort_order) select v::uuid, 'Mormor', 1 from ids where k = 'g1' returning id::text as person;
insert into ids select 'p1', id::text from public.people where name = 'Mormor';
insert into public.wishes (group_id, person_id, title, link)
  select (select v::uuid from ids where k = 'g1'), (select v::uuid from ids where k = 'p1'), 'Strikkepinner', 'https://example.com/a';
select pg_temp.check((select created_by from public.wishes where title = 'Strikkepinner') = auth.uid(), 'created_by defaults to caller');
select pg_temp.expect_error(
  $$ insert into public.wishes (group_id, person_id, title, link)
     select (select v::uuid from ids where k = 'g1'), (select v::uuid from ids where k = 'p1'), 'Skummel', 'javascript:alert(1)' $$,
  '23514', 'link must be empty or http(s)');
select pg_temp.expect_error(
  $$ insert into public.wishes (group_id, person_id, title, created_by)
     select (select v::uuid from ids where k = 'g1'), (select v::uuid from ids where k = 'p1'), 'Falsk', '00000000-0000-0000-0000-0000000000b2' $$,
  '42501', 'created_by is not client writable');

-- ---------------------------------------------------------------- bob
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;

insert into public.profiles (id, display_name) values (auth.uid(), 'Bob');
select pg_temp.check((select count(*) from public.groups) = 0, 'non-member sees no groups (and no invite token)');
select pg_temp.check((select count(*) from public.people) = 0, 'non-member sees no people');
select pg_temp.check((select count(*) from public.wishes) = 0, 'non-member sees no wishes');
select pg_temp.check((select count(*) from public.profiles) = 1, 'sees only own profile before sharing a group');
select pg_temp.expect_error($$ select public.join_group('feil') $$, 'P0002', 'unknown invite token');
select pg_temp.expect_error(
  $$ insert into public.group_members (group_id, user_id) select v::uuid, auth.uid() from ids where k = 'g1' $$,
  '42501', 'no direct insert into group_members');
select pg_temp.expect_error(
  $$ insert into public.people (group_id, name) select v::uuid, 'Inntrenger' from ids where k = 'g1' $$,
  '42501', 'non-member cannot add people');
update public.people set name = 'Hacket';
reset role;
select pg_temp.check((select count(*) from public.people where name = 'Hacket') = 0, 'non-member cannot rename people');

-- Bob gets the invite link (read as superuser here) and joins.
insert into ids select 'tok1', invite_token from public.groups where id = (select v::uuid from ids where k = 'g1');
set role authenticated;
select pg_temp.check(public.join_group((select v from ids where k = 'tok1'))::text = (select v from ids where k = 'g1'), 'join_group returns group id');
select pg_temp.check(public.join_group((select v from ids where k = 'tok1'))::text = (select v from ids where k = 'g1'), 'joining twice is harmless');
select pg_temp.check((select count(*) from public.group_members where group_id = (select v::uuid from ids where k = 'g1')) = 2, 'two members');
select pg_temp.check((select count(*) from public.profiles) = 2, 'members see each other''s profiles');
select pg_temp.check((select count(*) from public.wishes) = 1, 'member sees the wishes');

-- Bob's own group, with a person, to test cross-group references.
insert into ids select 'g2', public.create_group('Bobs venner')::text;
insert into public.people (group_id, name) select v::uuid, 'Kompis' from ids where k = 'g2';
insert into ids select 'p2', id::text from public.people where name = 'Kompis';
select pg_temp.expect_error(
  $$ insert into public.wishes (group_id, person_id, title)
     select (select v::uuid from ids where k = 'g1'), (select v::uuid from ids where k = 'p2'), 'Feil gruppe' $$,
  '23503', 'wish person must be in the same group');
select pg_temp.expect_error(
  $$ update public.wishes set group_id = (select v::uuid from ids where k = 'g2') $$, '42501', 'group_id is not updatable');
select pg_temp.expect_error(
  $$ update public.wishes set bought_by = '00000000-0000-0000-0000-0000000000a1' $$, '42501', 'bought_by is not client writable');

-- Ticking "Kjøpt": the server records who and when.
update public.wishes set bought = true where title = 'Strikkepinner';
select pg_temp.check((select bought_by = auth.uid() and bought_at is not null from public.wishes where title = 'Strikkepinner'), 'bought_by and bought_at set by server');
update public.wishes set bought = false where title = 'Strikkepinner';
select pg_temp.check((select bought_by is null and bought_at is null from public.wishes where title = 'Strikkepinner'), 'unticking clears buyer');
update public.wishes set bought = true where title = 'Strikkepinner';

-- Owner-only actions are refused for Bob in Alice's group.
update public.groups set name = 'Bobs nå' where id = (select v::uuid from ids where k = 'g1');
select pg_temp.check((select name from public.groups where id = (select v::uuid from ids where k = 'g1')) = 'Familien', 'only owner renames group');
select pg_temp.expect_error(
  $$ select public.regenerate_invite((select v::uuid from ids where k = 'g1')) $$, '42501', 'only owner regenerates invite');
delete from public.group_members where group_id = (select v::uuid from ids where k = 'g1') and user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check((select count(*) from public.group_members where group_id = (select v::uuid from ids where k = 'g1')) = 2, 'member cannot remove others');

-- ---------------------------------------------------------------- carol (outsider)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Carol');
select pg_temp.check((select count(*) from public.profiles) = 1, 'outsider sees no other profiles');
select pg_temp.check((select count(*) from public.group_members) = 0, 'outsider sees no members');
delete from public.wishes;
delete from public.people;
reset role;
select pg_temp.check((select count(*) from public.wishes) = 1, 'outsider cannot delete wishes');

-- ---------------------------------------------------------------- alice (owner)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select bought_by from public.wishes where title = 'Strikkepinner') = '00000000-0000-0000-0000-0000000000b2', 'others see who bought');
update public.groups set name = 'Familien Hansen' where id = (select v::uuid from ids where k = 'g1');
select pg_temp.check((select name from public.groups where id = (select v::uuid from ids where k = 'g1')) = 'Familien Hansen', 'owner renames group');
insert into ids select 'tok2', public.regenerate_invite((select v::uuid from ids where k = 'g1'));
select pg_temp.check((select v from ids where k = 'tok2') <> (select v from ids where k = 'tok1'), 'new token differs');
-- Owner removes Bob.
delete from public.group_members where group_id = (select v::uuid from ids where k = 'g1') and user_id = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.check((select count(*) from public.group_members where group_id = (select v::uuid from ids where k = 'g1')) = 1, 'owner removed member');

-- ---------------------------------------------------------------- bob again
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from public.people where group_id = (select v::uuid from ids where k = 'g1')) = 0, 'removed member loses access');
select pg_temp.expect_error($$ select public.join_group((select v from ids where k = 'tok1')) $$, 'P0002', 'old invite token stops working');
select public.join_group((select v from ids where k = 'tok2'));

-- ---------------------------------------------------------------- alice leaves: ownership passes to bob
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
delete from public.group_members where group_id = (select v::uuid from ids where k = 'g1') and user_id = auth.uid();
reset role;
select pg_temp.check((select owner_id from public.groups where id = (select v::uuid from ids where k = 'g1')) = '00000000-0000-0000-0000-0000000000b2', 'ownership passed to remaining member');

-- ---------------------------------------------------------------- last member leaves: group is deleted
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
delete from public.group_members where group_id = (select v::uuid from ids where k = 'g1') and user_id = auth.uid();
reset role;
select pg_temp.check((select count(*) from public.groups where id = (select v::uuid from ids where k = 'g1')) = 0, 'empty group deleted');
select pg_temp.check((select count(*) from public.people where group_id = (select v::uuid from ids where k = 'g1')) = 0, 'its people deleted');
select pg_temp.check((select count(*) from public.wishes where group_id = (select v::uuid from ids where k = 'g1')) = 0, 'its wishes deleted');

-- ---------------------------------------------------------------- anonymous
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;
select pg_temp.expect_error($$ select count(*) from public.people $$, '42501', 'anon cannot read people');
select pg_temp.expect_error($$ select public.join_group('x') $$, '42501', 'anon cannot call join_group');
reset role;

select 'ALL RLS CHECKS PASSED' as result;
rollback;

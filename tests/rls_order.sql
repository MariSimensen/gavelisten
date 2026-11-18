-- Checks for supabase/migrations/0003_personal_order.sql. Run after all
-- migrations, the same way as tests/rls.sql. Rolled back at the end.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob@example.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'carol@example.test');

create temporary table ids (k text primary key, v text);
grant all on ids to authenticated;

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

create function pg_temp.expect_error(stmt text, state text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'FAILED (no error): %', msg;
exception when others then
  if sqlerrm like 'FAILED (no error)%' then raise; end if;
  if sqlstate <> state then raise exception 'FAILED (got % "%" instead of %): %', sqlstate, sqlerrm, state, msg; end if;
end $$;
grant execute on function pg_temp.expect_error(text, text, text) to authenticated, anon;

create function pg_temp.id(key text) returns uuid language sql as $$ select v::uuid from ids where k = key $$;
grant execute on function pg_temp.id(text) to authenticated;

-- Alice owns g1 with p1, p2. Carol joins g1. Bob owns g2 with p3.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Alice');
insert into ids select 'g1', public.create_group('Familien')::text;
insert into public.people (group_id, name, sort_order) values (pg_temp.id('g1'), 'Mormor', 1), (pg_temp.id('g1'), 'Morfar', 2);
insert into ids select 'p1', id::text from public.people where name = 'Mormor';
insert into ids select 'p2', id::text from public.people where name = 'Morfar';
reset role;
insert into ids select 'tok', invite_token from public.groups where id = pg_temp.id('g1');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Carol');
select public.join_group((select v from ids where k = 'tok'));
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Bob');
insert into ids select 'g2', public.create_group('Bobs venner')::text;
insert into public.people (group_id, name) values (pg_temp.id('g2'), 'Kompis');
insert into ids select 'p3', id::text from public.people where name = 'Kompis';
reset role;

-- Alice sorts Morfar first, with an upsert like the app does.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
insert into public.person_order (person_id, group_id, position) values
  (pg_temp.id('p2'), pg_temp.id('g1'), 1), (pg_temp.id('p1'), pg_temp.id('g1'), 2)
  on conflict (user_id, person_id) do update set group_id = excluded.group_id, position = excluded.position;
insert into public.person_order (person_id, group_id, position) values (pg_temp.id('p2'), pg_temp.id('g1'), 2)
  on conflict (user_id, person_id) do update set group_id = excluded.group_id, position = excluded.position;
select pg_temp.check((select position from public.person_order where person_id = pg_temp.id('p2')) = 2, 'upsert updates own row');
select pg_temp.check((select user_id from public.person_order limit 1) = auth.uid(), 'user_id defaults to caller');
select pg_temp.check((select sort_order from public.people where id = pg_temp.id('p1')) = 1, 'shared order untouched');
select pg_temp.expect_error($$ insert into public.person_order (user_id, person_id, group_id, position) values ('00000000-0000-0000-0000-0000000000c3', pg_temp.id('p1'), pg_temp.id('g1'), 1) $$,
  '42501', 'cannot write a row for someone else');
select pg_temp.expect_error($$ insert into public.person_order (person_id, group_id, position) values (pg_temp.id('p3'), pg_temp.id('g2'), 1) $$,
  '42501', 'cannot order people in a group you are not in');
select pg_temp.expect_error($$ insert into public.person_order (person_id, group_id, position) values (pg_temp.id('p3'), pg_temp.id('g1'), 1) $$,
  '23503', 'person must be in the given group');
select pg_temp.expect_error($$ update public.person_order set user_id = '00000000-0000-0000-0000-0000000000c3' $$,
  '42501', 'user_id is not updatable');
reset role;

-- Carol, in the same group, sees none of Alice's rows and cannot change them.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from public.person_order) = 0, 'other members see no rows of mine');
update public.person_order set position = 9;
delete from public.person_order;
reset role;
select pg_temp.check((select count(*) from public.person_order where user_id = '00000000-0000-0000-0000-0000000000a1') = 2, 'others cannot change or delete my rows');

-- Bob, outside the group, sees nothing either.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from public.person_order) = 0, 'outsiders see no rows');
reset role;

-- Anonymous callers have no access at all.
set role anon;
select pg_temp.expect_error($$ select * from public.person_order $$, '42501', 'anon cannot read');
reset role;

-- Deleting a person removes everyone's order rows for that person.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
delete from public.people where id = pg_temp.id('p1');
reset role;
select pg_temp.check((select count(*) from public.person_order where person_id = pg_temp.id('p1')) = 0, 'order rows go with the person');

select 'ALL PERSONAL ORDER CHECKS PASSED' as result;
rollback;

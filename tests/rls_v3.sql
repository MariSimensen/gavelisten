-- Checks for supabase/migrations/0002_v3.sql: purchases, locks, images,
-- quantity and moving wishes. Run after both migrations, the same way as
-- tests/rls.sql:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f tests/rls_v3.sql
--
-- Everything runs in one transaction that is rolled back at the end.

begin;

-- Real Supabase blocks direct deletes from storage tables unless this is set
-- (the Storage service sets it the same way). Local to this transaction.
select set_config('storage.allow_delete_query', 'true', true);

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

-- ---------------------------------------------------------------- setup
-- Alice owns g1 (people p1, p1b; wishes w1 with quantity 3, w2 with quantity 1).
-- Carol joins g1. Bob owns g2 (person p2) and is never in g1.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Alice Hansen');
insert into ids select 'g1', public.create_group('Familien')::text;
insert into public.people (group_id, name) values (pg_temp.id('g1'), 'Mormor'), (pg_temp.id('g1'), 'Morfar');
insert into ids select 'p1', id::text from public.people where name = 'Mormor';
insert into ids select 'p1b', id::text from public.people where name = 'Morfar';
insert into public.wishes (group_id, person_id, title, quantity) values (pg_temp.id('g1'), pg_temp.id('p1'), 'Glass', 3);
insert into public.wishes (group_id, person_id, title) values (pg_temp.id('g1'), pg_temp.id('p1'), 'Sokker');
insert into ids select 'w1', id::text from public.wishes where title = 'Glass';
insert into ids select 'w2', id::text from public.wishes where title = 'Sokker';
select pg_temp.check((select quantity from public.wishes where title = 'Sokker') = 1, 'quantity defaults to 1');
select pg_temp.expect_error($$ update public.wishes set quantity = 0 where title = 'Glass' $$, '23514', 'quantity below 1 rejected');
select pg_temp.expect_error($$ update public.wishes set quantity = 100 where title = 'Glass' $$, '23514', 'quantity above 99 rejected');

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
insert into ids select 'p2', id::text from public.people where name = 'Kompis';
reset role;

-- ---------------------------------------------------------------- purchases
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
insert into public.wish_purchases (wish_id, group_id, n) values (pg_temp.id('w1'), pg_temp.id('g1'), 1);
select pg_temp.check((select user_id from public.wish_purchases where wish_id = pg_temp.id('w1')) = auth.uid(), 'purchase user_id defaults to caller');
select pg_temp.expect_error(
  $$ insert into public.wish_purchases (wish_id, group_id, user_id, n) values (pg_temp.id('w2'), pg_temp.id('g1'), '00000000-0000-0000-0000-0000000000c3', 1) $$,
  '42501', 'user_id is not client writable');
select pg_temp.expect_error(
  $$ insert into public.wish_purchases (wish_id, group_id, n) values (pg_temp.id('w1'), pg_temp.id('g2'), 1) $$,
  '42501', 'purchase group must be a group you are in');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from public.wish_purchases) = 1, 'member sees purchases in the group');
select pg_temp.expect_error(
  $$ insert into public.wish_purchases (wish_id, group_id, n) values (pg_temp.id('w1'), pg_temp.id('g1'), 3) $$,
  '23514', 'cannot buy more than the quantity (1 + 3 > 3)');
insert into public.wish_purchases (wish_id, group_id, n) values (pg_temp.id('w1'), pg_temp.id('g1'), 2);
-- Someone else's row: update and delete affect nothing.
update public.wish_purchases set n = 1 where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.wish_purchases where user_id = '00000000-0000-0000-0000-0000000000a1';
reset role;
select pg_temp.check((select n from public.wish_purchases where user_id = '00000000-0000-0000-0000-0000000000a1') = 1, 'cannot change or delete someone else''s purchase');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
select pg_temp.expect_error(
  $$ update public.wish_purchases set n = 2 where wish_id = pg_temp.id('w1') and user_id = auth.uid() $$,
  '23514', 'raising your own number past the quantity is rejected');
select pg_temp.expect_error(
  $$ update public.wish_purchases set user_id = '00000000-0000-0000-0000-0000000000c3' where user_id = auth.uid() $$,
  '42501', 'user_id is not updatable');
select pg_temp.expect_error(
  $$ update public.wish_purchases set at = now() - interval '1 day' where user_id = auth.uid() $$,
  '42501', 'at is not client writable');
-- Lowering the quantity keeps the purchases.
update public.wishes set quantity = 2 where id = pg_temp.id('w1');
select pg_temp.check((select sum(n) from public.wish_purchases where wish_id = pg_temp.id('w1')) = 3, 'lowering quantity keeps purchases');
-- Decreasing your own number is still allowed.
update public.wish_purchases set n = 0 + 1 where wish_id = pg_temp.id('w1') and user_id = auth.uid();
delete from public.wish_purchases where wish_id = pg_temp.id('w1') and user_id = auth.uid();
select pg_temp.check((select count(*) from public.wish_purchases where user_id = auth.uid()) = 0, 'can delete own purchase');
select pg_temp.expect_error(
  $$ update public.wishes set bought = true where id = pg_temp.id('w1') $$,
  '23514', 'ticking bought is rejected when purchases cover the quantity');
-- The checkbox purchase counts as one: w2 (quantity 1) ticked, then raised to 2.
update public.wishes set bought = true where id = pg_temp.id('w2');
update public.wishes set quantity = 2 where id = pg_temp.id('w2');
select pg_temp.check((select bought and bought_by = auth.uid() from public.wishes where id = pg_temp.id('w2')), 'raising quantity keeps a ticked purchase');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
insert into public.wish_purchases (wish_id, group_id, n) values (pg_temp.id('w2'), pg_temp.id('g1'), 1);
select pg_temp.expect_error(
  $$ update public.wish_purchases set n = 2 where wish_id = pg_temp.id('w2') and user_id = auth.uid() $$,
  '23514', 'checkbox purchase counts towards the quantity');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from public.wish_purchases) = 0, 'non-member cannot read purchases');
select pg_temp.expect_error(
  $$ insert into public.wish_purchases (wish_id, group_id, n) values (pg_temp.id('w2'), pg_temp.id('g1'), 1) $$,
  '42501', 'non-member cannot add a purchase');
update public.wish_purchases set n = 1;
delete from public.wish_purchases;
reset role;
select pg_temp.check((select count(*) from public.wish_purchases) = 2, 'non-member cannot change or delete purchases');

-- ---------------------------------------------------------------- locks
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((public.acquire_wish_lock(pg_temp.id('w1'), 'tab-a') ->> 'ok')::boolean, 'free lock is taken');
select pg_temp.check((public.acquire_wish_lock(pg_temp.id('w1'), 'tab-a2') ->> 'ok')::boolean, 'own lock can be taken again from another tab');
select pg_temp.check((public.renew_wish_lock(pg_temp.id('w1'), 'tab-a2') ->> 'ok')::boolean, 'own lock renews');
select pg_temp.expect_error($$ insert into public.wish_locks (wish_id, group_id, expires_at) values (pg_temp.id('w2'), pg_temp.id('g1'), now() + interval '1 hour') $$,
  '42501', 'no direct insert into wish_locks');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select locked_by from public.wish_locks where wish_id = pg_temp.id('w1')) = '00000000-0000-0000-0000-0000000000a1', 'member sees who is editing');
select pg_temp.check(public.acquire_wish_lock(pg_temp.id('w1'), 'tab-c') = public.acquire_wish_lock(pg_temp.id('w1'), 'tab-c'), 'acquire is repeatable');
select pg_temp.check(not (public.acquire_wish_lock(pg_temp.id('w1'), 'tab-c') ->> 'ok')::boolean, 'held lock cannot be taken');
select pg_temp.check((public.acquire_wish_lock(pg_temp.id('w1'), 'tab-c') ->> 'locked_by') = '00000000-0000-0000-0000-0000000000a1', 'refusal names the holder');
select public.release_wish_lock(pg_temp.id('w1'), 'tab-a2'); -- not Carol's to release
select pg_temp.expect_error($$ update public.wish_locks set expires_at = now() - interval '1 second' $$, '42501', 'no direct update of wish_locks');
select pg_temp.expect_error($$ delete from public.wish_locks $$, '42501', 'no direct delete from wish_locks');
reset role;
select pg_temp.check((select count(*) from public.wish_locks where locked_by = '00000000-0000-0000-0000-0000000000a1') = 1, 'cannot release or change someone else''s lock');

-- Let Alice's lock expire.
update public.wish_locks set expires_at = now() - interval '1 second' where wish_id = pg_temp.id('w1');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((public.acquire_wish_lock(pg_temp.id('w1'), 'tab-c') ->> 'ok')::boolean, 'expired lock can be taken');
reset role;
select pg_temp.check((select locked_by from public.wish_locks where wish_id = pg_temp.id('w1')) = '00000000-0000-0000-0000-0000000000c3', 'lock now held by Carol');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
select public.release_wish_lock(pg_temp.id('w1'), 'tab-a2');
reset role;
select pg_temp.check((select count(*) from public.wish_locks) = 1, 'old holder release does not remove the new lock');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from public.wish_locks) = 0, 'non-member cannot read locks');
select pg_temp.expect_error($$ select public.acquire_wish_lock(pg_temp.id('w2'), 'tab-b') $$, '42501', 'non-member cannot take a lock');
select public.release_wish_lock(pg_temp.id('w1'), 'tab-c');
reset role;
select pg_temp.check((select count(*) from public.wish_locks) = 1, 'non-member cannot release a lock');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
select public.release_wish_lock(pg_temp.id('w1'), 'tab-c');
select pg_temp.check((select count(*) from public.wish_locks) = 0, 'holder releases the lock');
reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;
select pg_temp.expect_error($$ select public.acquire_wish_lock(gen_random_uuid(), 'x') $$, '42501', 'anon cannot call acquire_wish_lock');
reset role;

-- ---------------------------------------------------------------- images
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
insert into ids values ('img1', (select v from ids where k = 'g1') || '/11111111-1111-4111-8111-111111111111.jpg');
insert into storage.objects (bucket_id, name) values ('wish-images', (select v from ids where k = 'img1'));
select pg_temp.expect_error(
  $$ insert into storage.objects (bucket_id, name) values ('wish-images', (select v from ids where k = 'g2') || '/22222222-2222-4222-8222-222222222222.jpg') $$,
  '42501', 'cannot upload into another group''s folder');
select pg_temp.expect_error(
  $$ insert into storage.objects (bucket_id, name) values ('wish-images', (select v from ids where k = 'g1') || '/evil.html') $$,
  '42501', 'object name must be <group>/<uuid>.jpg');
select pg_temp.expect_error(
  $$ insert into storage.objects (bucket_id, name) values ('wish-images', 'not-a-uuid/22222222-2222-4222-8222-222222222222.jpg') $$,
  '42501', 'folder must be a group id');
update public.wishes set image_path = (select v from ids where k = 'img1') where id = pg_temp.id('w1');
select pg_temp.expect_error(
  $$ update public.wishes set image_path = (select v from ids where k = 'g2') || '/22222222-2222-4222-8222-222222222222.jpg' where id = pg_temp.id('w2') $$,
  '23514', 'image_path must be in the wish''s group folder');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'wish-images') = 1, 'member can read the group''s images');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'wish-images') = 0, 'non-member cannot read images');
delete from storage.objects;
update storage.objects set name = 'x';
reset role;
select pg_temp.check((select count(*) from storage.objects where name = (select v from ids where k = 'img1')) = 1, 'non-member cannot delete or rename images');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
delete from storage.objects where name = (select v from ids where k = 'img1');
reset role;
select pg_temp.check((select count(*) from storage.objects) = 0, 'member can delete the group''s images');
select pg_temp.check((select not public and file_size_limit = 5242880 from storage.buckets where id = 'wish-images'), 'bucket is private with a 5 MB limit');

-- ---------------------------------------------------------------- moving wishes
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}', false);
set role authenticated;
update public.wishes set person_id = pg_temp.id('p1b') where id = pg_temp.id('w2');
select pg_temp.check((select person_id from public.wishes where id = pg_temp.id('w2')) = pg_temp.id('p1b'), 'wish moves to another person in the group');
select pg_temp.expect_error(
  $$ update public.wishes set person_id = pg_temp.id('p2') where id = pg_temp.id('w2') $$,
  '23503', 'wish cannot move to a person in another group');
select pg_temp.expect_error(
  $$ update public.wishes set group_id = pg_temp.id('g2') where id = pg_temp.id('w2') $$,
  '42501', 'group_id is still not updatable');
reset role;

-- Deleting a wish removes its purchases and lock.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
select public.acquire_wish_lock(pg_temp.id('w2'), 'tab-a');
delete from public.wishes where id = pg_temp.id('w2');
reset role;
select pg_temp.check((select count(*) from public.wish_purchases where wish_id = pg_temp.id('w2')) = 0, 'purchases go with the wish');
select pg_temp.check((select count(*) from public.wish_locks where wish_id = pg_temp.id('w2')) = 0, 'lock goes with the wish');

select 'ALL V3 RLS CHECKS PASSED' as result;
rollback;

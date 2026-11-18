-- Gavelisten: shared order of the wishes inside each person's list.
--
-- Runs after 0003_personal_order.sql. Safe to run more than once.
--
-- Anyone in the group can drag a wish up or down within its list, and
-- everyone sees the same order (unlike the name chips, which are personal):
-- the order says something about the wishes, for example the most wanted
-- first, so the buyers should see it too. Wishes never move between lists
-- by dragging; "Ønske til" in the edit form does that.
--
-- Existing wishes keep the order they had (oldest first). New wishes get the
-- next number from the app. A null sorts after numbered wishes, by age.

alter table public.wishes add column if not exists sort_order integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wishes_sort_order_check' and conrelid = 'public.wishes'::regclass) then
    alter table public.wishes add constraint wishes_sort_order_check check (sort_order is null or sort_order between 1 and 100000);
  end if;
end $$;

update public.wishes w
   set sort_order = x.n
  from (select id, row_number() over (partition by person_id order by created_at, id) as n from public.wishes) x
 where w.id = x.id and w.sort_order is null;

-- Same policies as the other wish columns: any member of the group.
grant insert (sort_order), update (sort_order) on public.wishes to authenticated;

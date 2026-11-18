# Gavelisten

A shared wish list for families and groups of friends. Each group has cards
per person with wishes (title, optional link and price). Anyone in the group
can tick a wish as bought ("Kjøpt av X, i dag 14:05"), and each viewer can
hide what has been bought, so the person the gifts are for can use the list
too. The interface is in Norwegian.

It is a static site (plain HTML, CSS and JavaScript, no build step) meant for
GitHub Pages, with [Supabase](https://supabase.com) for the database, sign-in
(e-mail magic link) and live updates.

## Files

| File | What it is |
|------|------------|
| `index.html` | Page markup and styles |
| `app.js` | All app logic |
| `config.js` | Supabase project URL and anon key (you fill these in) |
| `supabase/migrations/0001_init.sql` | Database schema, row level security, RPCs, realtime |
| `tests/rls.sql` | Checks for the security rules, run against a local Supabase |

## Setup

### 1. Create the database

1. Create a Supabase project.
2. Run `supabase/migrations/0001_init.sql`, either in the dashboard
   (SQL Editor, paste and run) or with the CLI: `supabase init` (once, it
   adds `supabase/config.toml`), `supabase link --project-ref <ref>` and
   then `supabase db push`.

### 2. Configure sign-in

In the Supabase dashboard, under Authentication:

1. **Sign In / Providers**: keep Email enabled. Magic links need no password.
2. **URL Configuration**:
   - **Site URL**: the GitHub Pages address, for example
     `https://<user>.github.io/gavelisten/`.
   - **Redirect URLs**: add the same address. The app asks Supabase to send
     people back to the page they signed in from (without query or hash), so
     that exact URL must be allowed. Add `http://localhost:8000/` too if you
     want to test locally.
3. Optional: the built-in e-mail sender is heavily rate limited. For real use,
   set up your own SMTP server under Authentication > Emails, and consider
   translating the magic link e-mail template to Norwegian.

### 3. Fill in `config.js`

Copy the values from Project Settings > API:

```js
window.GAVELISTEN_CONFIG = {
  supabaseUrl: "https://<ref>.supabase.co",
  supabaseAnonKey: "<anon public key>",
};
```

The anon key is meant to be public. Everything it can do is limited by the
row level security policies in the migration. Never put the `service_role`
key in this repository.

### 4. Publish on GitHub Pages

Push the repository and enable Pages (Settings > Pages, deploy from the
`main` branch, root folder). There is nothing to build.

To try it locally, serve the folder with any static server, for example
`python3 -m http.server 8000`, and open `http://localhost:8000/`.

## How groups work

- The first time someone signs in they choose a display name, which the
  other members see.
- Someone who is in no group can create one. The creator becomes its owner.
- Every group has a secret invite link (`<page>?bli-med=<token>`) shown under
  "Inviter og medlemmer". Opening it, before or after signing in, adds you to
  the group.
- People can be in several groups and switch between them at the top of the
  page. The last chosen group is remembered on that device.
- All members can add, change and delete people and wishes in the group.
- The owner can rename the group, make a new invite link (the old one stops
  working) and remove members. Removing someone does not change the link, so
  make a new link as well if they should not be able to come back.
- Anyone can leave. If the owner leaves, the member who has been in the group
  longest becomes owner. When the last member leaves, the group and all its
  lists are deleted.

## Security model

- Row level security is enabled on every table. Members can only see and
  change the groups they belong to; profiles are visible to yourself and to
  people you share a group with.
- Groups and memberships are only created through the `create_group` and
  `join_group` functions. Invite tokens are 144 random bits and only readable
  by members.
- Who bought a wish and when is set by a database trigger from the signed-in
  user, not by the browser, so it cannot be faked.
- A wish's person must belong to the same group (composite foreign key).
- Table privileges are per column, so clients cannot change ids, group
  membership of rows, owners or buyers directly.
- The page has a Content Security Policy that only allows scripts from the
  site itself and the pinned supabase-js build on jsDelivr (with a
  Subresource Integrity hash), and network calls only to `*.supabase.co`. If
  you use a custom Supabase domain, update `connect-src` in `index.html`.
- User text is always inserted with `textContent`, never as HTML, and links
  are limited to `http://` and `https://`.

Sign-in uses the implicit magic link flow, so the link works even when it is
opened in a different browser than the one it was requested from (common
when the e-mail is read on a phone).

## Live updates

The page subscribes to Supabase Realtime changes on `people`, `wishes` and
`group_members` filtered on the current group, and refetches the group's data
when anything changes. Postgres cannot filter delete events by column, so
every open page gets notified of every delete (only the row id, no content)
and refetches. That is fine at family scale.

## Testing the database rules

`tests/rls.sql` checks the policies, RPCs and triggers as different users,
inside a transaction that is rolled back. With the Supabase CLI and Docker:

```sh
supabase init             # once, if supabase/config.toml does not exist yet
supabase start
supabase db reset          # applies the migration
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f tests/rls.sql
```

It ends with `ALL RLS CHECKS PASSED`, or stops at the first failed check.

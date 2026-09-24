---
name: up-to-date-docs
description: Read the current documentation of a library, framework or API before writing or changing code that uses it. Use whenever code depends on a third-party package (React, Next.js, Tailwind, Stripe, a Telegram bot library, an SDK) so the code follows today's API, not a remembered old one.
---

# Up-to-date docs

Your memory of a library can be out of date. Before you write code against a
library, check its current docs through Context7 — a free public index of
library documentation. No key is needed.

## When

- Adding or upgrading a dependency.
- Using an API you have not used in this project yet.
- An error suggests a function, option or import path no longer exists.

Skip it for the language itself and the standard library.

## How

1. Find the library id:

   ```bash
   curl -s "https://context7.com/api/v1/search?query=<library name>" | head -c 2000
   ```

   Take the `id` of the best match, e.g. `/vercel/next.js`.

2. Read the docs for the part you need (keep `tokens` small, raise it only if needed):

   ```bash
   curl -s "https://context7.com/api/v1/<id>?type=txt&topic=<topic>&tokens=4000"
   ```

   Example: `https://context7.com/api/v1/vercel/next.js?type=txt&topic=routing&tokens=4000`.

3. Check the installed version (`package.json`, `requirements.txt`, lock files).
   If it differs from the docs, follow the installed version or say you are upgrading.

4. Write the code. In your reply, mention in one line which docs you checked.

If Context7 is unreachable or has no entry, use the library's official docs site
and say so. Never invent an API you could not confirm.

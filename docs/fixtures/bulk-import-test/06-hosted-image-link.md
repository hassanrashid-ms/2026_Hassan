---
title: Hosted Image Works Fine
tags: [images]
---

This image is an **absolute URL**, not a file bundled in the zip, so it will
render correctly after import — nothing about bulk import needs to touch it.

![Placeholder hosted externally](https://placehold.co/400x200)

Compare this to `01-full-frontmatter.md` and `02-h1-fallback.md`, which
reference `images/placeholder-*.svg` bundled in this same zip:

- Hosted URLs → _render fine_
- Zip-relative paths → **broken image**, always

Local zip-relative paths are never uploaded anywhere.

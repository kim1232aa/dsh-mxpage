test: verify the Xiaohongshu four-step flow end to end

Step 1 plans three pages (padding/cropping to imageCount, every page carrying a
title and an imagePrompt), step 3 generates one image per page as base64 data
URLs with the used model reported, and step 4 edits a single page in place.

The test also pins the flow's defining property: it is HTTP-only. It must never
create a project and must never write a generated asset, which is exactly why
upstream kept the XHS draft in localStorage + IndexedDB and why a headless host
has to supply its own persistence for it.

Full suite: 41 tests, 41 pass. tsc --noEmit: 0 errors.

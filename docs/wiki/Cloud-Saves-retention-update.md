# Prepared Wiki update

The [reviewable patch](pre-release-remediation.patch) updates the actual Cloud Saves,
Account Recovery, Leaderboards, Upgrades and Security pages from Wiki commit
`01817e99a67a1517166757da33ef1a10e7227e28`. The Wiki was cloned and edited locally only; nothing was pushed.

It corrects the indefinite replay wording, updates durable-write examples with
generation, documents bounded retention and upload rates, describes deleted-user
authorization, preserves five-revision recovery guidance and explains exact-rank
pagination costs. Apply/push only after separate authorization.

The zero-context patch was checked against that exact base commit. Review it
there and use `git apply --unidiff-zero pre-release-remediation.patch` only after
choosing to apply the local update; pushing remains separately authorized.

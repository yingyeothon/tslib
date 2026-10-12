# Game kit

- Read the service's `docs/game-kit-design.md` before changing kit events,
  errors, serialization or scenarios. Freeze shared wire behavior there first.
- Bind each asynchronous mutation to its original session generation and
  credential. Guard after storage/merge/hydration awaits as well as HTTP awaits;
  entry-only checks allow an old user's write to reach a new user's namespace.
- Serialize token store/clear, invalidate pending restores on sign-out, and
  reserve snapshot revisions through a serial lane. Memory guards alone do not
  protect durable tokens or concurrent state publication.
- Treat queue acknowledgement as a recoverable phase. A successful conditional
  PUT followed by failed adapter cleanup must not strand the original record;
  confirm an already-satisfied newer value without overwriting a differing one.
- Separate turn validation from persistence. Storage outages report errors and
  retain retryable log/result intent; only hash/apply divergence freezes a game.
- Select the actual online log responder, including for a recovering host.
  Stage complete chunks before replacing state; bound both bytes and requests,
  reject empty chunks, and never mix responder streams.
- Check array descriptors as well as object descriptors for canonical JSON.
  Getter/custom serializer execution makes hashes depend on evaluation count.
- Keep the fakes in `test-support/` structural and engine-free. A fake scenario
  establishes library behavior, not deployed service or real-device delivery.

- Resolve save-name merge policies from own properties only. Valid names such as
  `constructor` must not accidentally select an inherited Object method as a
  registered conflict policy.

- Treat the kit's full delivery as one release unit. Implementation milestones
  may use focused tests and local commits; publish once after the complete
  requested scope passes final review and consumer verification.
- Read actual route responses before writing doubles. LB submit returns stored
  periods without ranks; query own scores to supply kit ranks and never silently
  resubmit a successful sum write when the follow-up reads fail.
- Use `missing: "error"` for conditional mail claims. The service may answer
  404 after another claimant deleted the row; the KV default folds that away.
- Guard event emission per item and per observer. A listener can synchronously
  switch session; a guard before the batch does not protect later private data.
- Discover deferred tickets on push/resume without requiring a local submission.
  Accept empty matchId expiry hints, arm polling after status/conflict recovery,
  and return only joined members for partial callback-less room formation.

- Live match delivery and lobby invitations are separate streams. Buffer recent
  invites while waiting for matched, then validate sender membership before any
  acceptance. Bound the buffer and clear its observer on every outcome.

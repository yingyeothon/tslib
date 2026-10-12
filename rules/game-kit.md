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

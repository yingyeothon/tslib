# Security

Lessons from adversarial security reviews of this repository. All of these were
real defects that shipped in the legacy code.

## Wire protocol construction

- Never build a Redis command by interpolating user data into a string. All
  commands go through `quoteArg`/`serializeCommand` in
  `packages/naive-redis/src/exchange/`.
- The inline command form is only safe for arguments free of whitespace, quotes,
  backslashes, and control characters. Everything else must use the
  length-prefixed RESP array form — otherwise a `\r\n` inside a key or value
  injects arbitrary Redis commands (`SET k v\r\nFLUSHALL`).
- RESP bulk lengths are **byte** counts, not string lengths, or multi-byte UTF-8
  arguments desynchronize the stream.
- **Both** quote characters break the inline form. Redis's inline parser
  treats `'` as a delimiter anywhere in a token, so `SET k v'` is answered
  with "unbalanced quotes" and the connection is closed — and `SET k' v'`
  merges two arguments into one without any error at all.
- A reply matcher must consume the **whole** reply, not the shape you
  expected. A one-line matcher pointed at a command whose reply can be a
  bulk string or an array leaves the tail in the receive buffer, and the
  next command on that connection resolves with a fragment of this one —
  silently. Frame first, then reject the shape you cannot use.
- The same reasoning applies to any new text protocol: escape at a single
  choke-point helper, and add a protocol test for the escaping.

## Distributed locks

- A lock's value must be a per-acquisition random token, and `release` must be
  a Lua compare-and-delete. A bare `DEL` deletes whatever is there — including
  the lock a _new_ owner took after this holder's lease expired — and then two
  actors simulate the same game. `renew` compares the same way before
  extending, and its `false` means "someone else owns this now".
- A holder that cannot prove ownership must refuse rather than force. A forced
  break of a stale lock is a different, deliberate operation: do it with a
  direct `DEL` at the one place that means it (`handleDebugStart`), and say so
  in a comment.
- The token is a credential. It must never reach a log line, at any level.
- Drop the token **after** the release command comes back, not before: a
  release that failed on a broken connection has to stay retryable, or the
  lock is held until it expires — forever, if it has no expiry.
- Detecting the loss is half the fix. A heartbeat that only logs "lost the
  lock" leaves both owners running; the loser must stop consuming, which is
  why `eventLoop`'s `poll` rejects from that moment and `tryToProcess` ends
  its drain loop.
- An expired lease is not a loss. The lease is a deadline for a _successor_
  — it exists so a crashed holder frees the resource quickly — so a holder
  that is still working re-acquires and carries on, and only a failed
  re-acquisition means someone else took it. Without that distinction a
  short lease turns every store outage longer than it into a lost session,
  which is how a safety mechanism becomes the outage.

## Trusting client-supplied identity

- A message type the server treats as bookkeeping must be unforgeable. In
  `lambda-gamebase`, `enter`/`leave` decide which member a connection speaks
  for; `handleMessages` refuses them via `isReservedRequestType` at the one
  point client input enters the actor queue.
- Refusing a message type is not authentication. Identity has to come from a
  verified principal, which is why `handleConnect` takes `resolveMemberId`:
  the default still reads `x-member-id`, and production passes a resolver over
  `event.requestContext.authorizer`. When you close one path, say in the code
  what the remaining ones are instead of claiming a "single choke point".
- A resolver that returns `undefined` must reject. Fail closed: an identity
  seam whose failure mode is "fall back to what the client said" is not a seam.
- Check identity once, at the point the binding is made. `$default` routes by
  `connectionId` alone, so re-checking a principal there adds surface, not
  safety — the connection's member was decided at `$connect`.

## API Gateway authorizers

- WebSocket APIs accept a `REQUEST` authorizer on `$connect` and no other
  _Lambda_ authorizer (`AWS_IAM` is separately available). A `TOKEN` authorizer
  is REST-only; `createAuthorizer` cannot be attached to a WebSocket API, which
  is why `createRequestAuthorizer` exists. Verify a claim like this against
  current AWS docs before designing around it — and keep the qualifier, because
  "no other authorizer type" is the version of the sentence that is false.
- Identity sources are enforced only when authorizer caching is on: then every
  declared source must be present and non-empty or API Gateway answers 401
  without invoking the function. With caching off it invokes the function
  regardless. So the TTL-0 recommendation and "declare only the source your
  clients actually send" are the same decision seen twice.
- The authorizer's context stays with the connection and reaches `$connect`,
  `$default`, and `$disconnect` as `event.requestContext.authorizer`. It only
  carries strings, numbers, and booleans, so claims must be flattened.
- Keep that context narrow. `$context.authorizer.*` can be configured into
  access logs, so a token or an email placed there is a token or an email in
  the logs. Never echo a verified bearer token back into the context: the
  caller already has it. A token the authorizer _issues_ is the one legitimate
  exception (that is how the caller receives it) — say so where it happens, and
  say that the context must then stay out of access logs.
- Strip the context from a Deny. A refused request reaches the access log too,
  and the reason an authorizer refused is usually more sensitive than the
  reason it allowed.
- Allowing without an identity is a fail-open. If the authorizer cannot name
  the caller, deny; do not leave it to the integration to notice. And set
  `principalId` — it defaults to a constant, so an integration reading it sees
  every caller as the same one.
- Require an expiry. A bearer token with no `exp` makes every "the allow cannot
  outlive the credential" guarantee vacuous.
- Set the result cache TTL to 0 on `$connect`. It runs once per connection, so
  caching buys nothing and lets an allow outlive the credential's expiry.
- An authorizer cannot revoke an established connection. Mid-session ejection
  belongs to the application (`Transport.drop`).
- A browser cannot set headers on a WebSocket handshake. The credential travels
  as a query string (written to access logs) or as
  `Sec-WebSocket-Protocol: bearer, <token>` — prefer the subprotocol, and
  remember the `$connect` integration must echo the selected subprotocol back
  or the browser aborts the handshake.
- A valid signature proves who minted a token, not who it was minted for. Pin
  `issuer` and `audience`. With a shared symmetric secret every holder can mint
  any identity, so the secret is a signing capability, not a verification key.

## Logging secrets

- Never log a raw receive buffer. It is whatever the peer just sent — a
  stored value, a credential echo, a game payload. Report its size.
- Never log an entire request event. `APIGatewayProxyEvent` carries `headers`
  (`Authorization`, `Cookie`, `X-Api-Key`) and a body that may hold PII.
- Log non-sensitive descriptors only: path, request id, actor id, error name.
- Payloads are secrets too, and `debug` is not a free pass: a queue that logs
  its item, a broadcast that logs its response body, or an actor that logs its
  whole start event puts game state and member e-mail addresses into whatever
  writer the consumer plugged in. Log the routing facts — key, `messageId`,
  `type`, counts — never the thing being routed.
- Domain objects hide PII too: `GameStartMember` carries `name` and `email`,
  and a game context carries every member and connection id. Log counts
  (`describeGame`, `memberCount`) rather than the object, and log a message's
  `type` rather than the message.
- Authorizers must not log raw authorization headers, issued JWTs, parsed
  credentials, decoded claims, or Redis passwords. Redact at the call site, not
  in the writer — consumers plug in real writers that persist logs indefinitely.
  Log presence, scheme, and policy effect; that is enough to debug a 401.
- The leak is usually one level up from the secret: logging a whole `Authorized`
  or the finished policy prints the context, and logging a whole start event on
  a membership failure prints every member's name and email. Log the decision,
  not the object that carried it.

## Review habit

- Run a security-focused adversarial review on any change that touches protocol
  serialization, authentication/authorization, or logging of request data.

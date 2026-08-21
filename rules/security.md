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
- The same reasoning applies to any new text protocol: escape at a single
  choke-point helper, and add a protocol test for the escaping.

## Trusting client-supplied identity

- A message type the server treats as bookkeeping must be unforgeable. In
  `lambda-gamebase`, `enter`/`leave` decide which member a connection speaks
  for; `handleMessages` refuses them via `isReservedRequestType` at the one
  point client input enters the actor queue.
- Refusing a message type is not authentication. `handleConnect` still takes
  `memberId` from `x-member-id`, so identity has to come from an authorizer's
  claims. When you close one path, say in the code what the remaining ones
  are instead of claiming a "single choke point".

## Logging secrets

- Never log an entire request event. `APIGatewayProxyEvent` carries `headers`
  (`Authorization`, `Cookie`, `X-Api-Key`) and a body that may hold PII.
- Log non-sensitive descriptors only: path, request id, actor id, error name.
- Domain objects hide PII too: `GameStartMember` carries `name` and `email`,
  and a game context carries every member and connection id. Log counts
  (`describeGame`, `memberCount`) rather than the object, and log a message's
  `type` rather than the message.
- Authorizers must not log raw authorization headers, issued JWTs, parsed
  credentials, or Redis passwords. Redact at the call site, not in the writer —
  consumers plug in real writers that persist logs indefinitely.

## Review habit

- Run a security-focused adversarial review on any change that touches protocol
  serialization, authentication/authorization, or logging of request data.

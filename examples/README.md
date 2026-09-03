# Examples

Runnable programs the guide points at. **Every one of them
runs with no AWS credentials, no Docker and no deployed gateway**; Redis or a
real gateway is opt-in behind an environment variable. They are typechecked and
smoke-tested in CI, so a snippet the documentation depends on cannot rot. Two of
them can be pointed at a Redis you started yourself, with
`YYT_EXAMPLE_REDIS_HOST`; none of them talks to a deployed gateway.

| Example                                        | Shows                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| [actor-game](actor-game/README.md)             | A whole game through the real `handleActor`, with no AWS and no Redis         |
| [gateway-client](gateway-client/README.md)     | A lobby and a dungeon client, and a finished run against an aborted one       |
| [gateway-contract](gateway-contract/README.md) | The three ways a WebSocket gateway silently fails to reach an actor           |
| [repository-cas](repository-cas/README.md)     | Two writers racing on one document, and the conditional write that keeps both |

```bash
pnpm --filter yyt-example-actor-game start
pnpm --filter yyt-example-gateway-client start
pnpm --filter yyt-example-gateway-contract start
pnpm --filter yyt-example-repository-cas start
```

These are deliberately single-purpose. The full deployable stacks — a real
Serverless deployment, an auth service, a gateway channel — live in the
[`examples`](https://github.com/yingyeothon/examples) repository as
`sample-dungeon` and `sample-morpg`, and are not duplicated
here.

Links run one way: the guide points into these, and these point at the package
READMEs. An example never links forward into `docs/`, so neither half can be
written into a broken state while the other is still being drafted.

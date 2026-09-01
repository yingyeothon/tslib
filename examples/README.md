# Examples

Runnable programs the guide points at. **Every one of them
runs with no AWS credentials, no Docker and no deployed gateway**; Redis or a
real gateway is opt-in behind an environment variable. They are typechecked and
smoke-tested in CI, so a snippet the documentation depends on cannot rot.

| Example                                    | Shows                                                                         | Guide page                    |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------- |
| [actor-game](actor-game/README.md)         | A whole game through the real `handleActor`, with no AWS and no Redis         |
| [repository-cas](repository-cas/README.md) | Two writers racing on one document, and the conditional write that keeps both | [Storage](../docs/storage.md) |

```bash
pnpm --filter yyt-example-actor-game start
pnpm --filter yyt-example-repository-cas start
```

These are deliberately single-purpose. The full deployable stacks — a real
Serverless deployment, an auth service, a gateway channel — live in the
[`service`](https://github.com/yingyeothon/service) repository as
`examples/sample-dungeon` and `examples/sample-morpg`, and are not duplicated
here.

Links run one way: the guide points into these, and these point at the package
READMEs. An example never links forward into `docs/`, so neither half can be
written into a broken state while the other is still being drafted.

# Push example

Register a supplied Android FCM token, send from a server, replay a campaign job,
obtain a report URL and broadcast through a structural in-memory fake. No cloud
credentials, Docker, deployed services or FCM SDK are required.

```bash
pnpm build
pnpm --filter yyt-example-push start
```

The output distinguishes FCM acceptance from users without a token, and confirms
that the second submission reuses the first job. The fake never delivers to a
phone and bypasses actual CSV/object processing with `putUpload`.

Production applications obtain device tokens from their own SDK. Servers upload
CSV bytes and fetch reports with signed headers only, without an API key on
object-storage requests. Templates are provisioned through the console.

See [push-client](../../packages/push-client/README.md) and
[push-server](../../packages/push-server/README.md) for the public APIs.

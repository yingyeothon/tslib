# Game kit walkthrough

Run time, conditional saves, TTL claims, guarded counters, room invitations,
host succession and turn replay against in-memory protocol doubles.

```bash
pnpm --filter yyt-example-game-kit start
```

Build the workspace first (`pnpm build`). The example needs no infrastructure,
credentials or network access. Its synthetic JWTs are accepted only by its fakes;
these doubles are not production authentication servers. The output includes
both players' final state and the state inherited by the next host.

API references: [game-kit](../../packages/game-kit/README.md),
[platform-client](../../packages/platform-client/README.md),
[auth-client](../../packages/auth-client/README.md).

## Browser callback

Host `callback.html` on the same origin as the game and allow its URL on the
service auth channel. Pass that URL as `login.redirectUrl`. The popup adapter
reads the returned URL, clears the child window's fragment and closes it; the
callback page does not transmit the fragment or run third-party scripts. This
is a callback template, not an OAuth provider registration or a deployed demo.

The additional walkthrough covers leaderboard submission, a mail claim race,
mutual friendship and presence, four-player live room formation, deferred
confirmation, and token/topic cleanup on sign-out (shared scenarios 5–10).
The doubles do not prove OAuth consent or receipt on a phone.

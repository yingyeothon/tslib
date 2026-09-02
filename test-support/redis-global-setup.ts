import { RedisContainer } from "@testcontainers/redis";
import type { TestProject } from "vitest/node";

/**
 * Vitest `globalSetup` shared by every package whose suite needs a Redis:
 * starts one container per project and hands its address to the tests
 * through `inject("redisHost")` / `inject("redisPort")`.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const container = await new RedisContainer("redis:7-alpine").start();
  project.provide("redisHost", container.getHost());
  project.provide("redisPort", container.getMappedPort(6379));
  return async () => {
    await container.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    redisHost: string;
    redisPort: number;
  }
}

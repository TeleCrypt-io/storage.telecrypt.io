/**
 * Registers real accounts for E2E tests the exact same way
 * test/harness/users.ts does for the library's own functional tests — kept
 * as a thin, UI-suite-local copy rather than a cross-package import so ui/
 * has no reach-through dependency on the root test/ tree's module resolution.
 *
 * The throwaway stack's Synapse delegates auth to a local MAS (MSC3861,
 * compatibility mode),
 * so plain `POST /_matrix/client/v3/register` is refused ("Registration has
 * been disabled") — account creation goes through `mas-cli manage
 * register-user` (shelled out via `podman exec`, same as the root harness).
 * The browser then authenticates only through MAS OAuth. A narrowly scoped
 * compatibility login below is fixture-only and discarded: it polls the
 * asynchronous MAS-to-Synapse provisioning job before browser OAuth starts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface E2eUser {
  userId: string;
  localpart: string;
  password: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function registerUserInMas(username: string, password: string): Promise<void> {
  try {
    await execFileAsync("podman", [
      "exec",
      "throwaway-mas",
      "mas-cli",
      "manage",
      "register-user",
      username,
      "--password",
      password,
      "--yes",
      "--ignore-password-complexity",
      "-c",
      "/data/config.yaml",
    ]);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `mas-cli register-user failed for "${username}": ${e.stderr || e.stdout || e.message}`,
    );
  }
}

/**
 * Fixture-only readiness probe. MAS provisions the Synapse-side account in
 * a background job after register-user returns, and an immediate OAuth token
 * exchange can otherwise race that job. The resulting compatibility session
 * is discarded and never reaches product code; production UI auth remains
 * exclusively OAuth through MAS.
 */
async function waitForFixtureProvisioning(
  username: string,
  password: string,
  attempts = 20,
  delayMs = 300,
): Promise<{ user_id: string }> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch("http://localhost:8008/_matrix/client/v3/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username },
        password,
      }),
    });
    if (response.ok) return (await response.json()) as { user_id: string };

    const body = await response.text();
    if (response.status !== 500 || attempt === attempts) {
      throw new Error(`fixture provisioning probe failed (${response.status}): ${body}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("waitForFixtureProvisioning: exhausted attempts");
}

export async function registerE2eUser(prefix: string): Promise<E2eUser> {
  const suffix = randomSuffix();
  // MAS enforces the Matrix user ID grammar strictly (lowercase localpart) —
  // see the matching comment in test/harness/users.ts.
  const localpart = `${prefix}_${suffix}`.toLowerCase();
  const password = `pwd_${suffix}`;

  await registerUserInMas(localpart, password);
  const provisioned = await waitForFixtureProvisioning(localpart, password);
  return { userId: provisioned.user_id, localpart, password };
}

/** Polls the raw server-side key backup endpoint until it reports at least
 * `minCount` stored keys — the authoritative proof the background backup
 * engine actually finished uploading (mirrors test/functional/keys.test.ts's
 * waitForServerBackupCount). Needs a device access token, which the UI
 * doesn't expose in the DOM, so the caller reads its OAuth session from the
 * test browser's localStorage. */
export async function waitForServerBackupCount(
  accessToken: string,
  minCount: number,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch("http://localhost:8008/_matrix/client/v3/room_keys/version", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const info = (await res.json()) as { count?: number };
      if ((info.count ?? 0) >= minCount) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for server backup count >= ${minCount}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

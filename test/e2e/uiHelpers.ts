import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { E2eUser } from "./testUsers";

export async function loginViaUI(page: Page, user: E2eUser): Promise<void> {
  await page.goto("/");
  await page.getByTestId("oidc-login").click();

  // The application only initiates OAuth. These fields belong to the MAS
  // authorization server after the redirect, never to storage.telecrypt.io.
  await page.waitForURL(/localhost:8082/, { timeout: 20_000 });
  await page.getByLabel("Username").fill(user.localpart);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Continue" }).click();

  // A newly registered dynamic client needs one consent approval; a client
  // already approved by this browser proceeds directly back to the app.
  const consentCheckbox = page.locator('input[type="checkbox"]');
  if (await consentCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await consentCheckbox.check();
    await page.getByRole("button", { name: "Continue" }).click();
  }

  await expect(page.getByTestId("current-user")).toHaveText(user.userId, { timeout: 20000 });
}

export async function createVault(page: Page, name: string): Promise<string> {
  await page.getByTestId("nav-folders").click();
  await page.getByTestId("create-vault").click();
  const renameInput = page.getByTestId("rename-vault-input");
  await expect(renameInput).toBeVisible({ timeout: 20000 });
  await renameInput.fill(name);
  await renameInput.press("Enter");
  const item = page.locator('[data-testid="vault-item"]', { hasText: name });
  await expect(item).toBeVisible({ timeout: 20000 });
  const folderId = await item.getAttribute("data-folder-id");
  if (!folderId) throw new Error(`vault item for "${name}" has no data-folder-id`);
  return folderId;
}

/** @deprecated use createVault */
export const createFolder = createVault;

export async function openVaultByName(page: Page, name: string): Promise<void> {
  await page.locator(".folder-list-btn", { hasText: name }).click();
  await expect(page.getByTestId("folder-detail")).toBeVisible();
}

/** @deprecated use openVaultByName */
export const openFolderByName = openVaultByName;

/** userB's side: accept a pending invite for the shared vault. */
export async function joinFolder(
  page: Page,
  folderId: string,
  folderName?: string,
): Promise<void> {
  await page.getByTestId("nav-folders").click();
  const invite = page.locator('[data-testid="invite-item"]', {
    has: page.locator(`[data-folder-id="${folderId}"]`),
  });
  if (await invite.isVisible({ timeout: 5000 }).catch(() => false)) {
    await invite.getByTestId("accept-invite").click();
  } else if (folderName) {
    const byName = page.locator('[data-testid="invite-item"]', { hasText: folderName });
    await expect(byName).toBeVisible({ timeout: 20000 });
    await byName.getByTestId("accept-invite").click();
  } else {
    await expect(invite).toBeVisible({ timeout: 20000 });
    await invite.getByTestId("accept-invite").click();
  }
  await expect(page.locator(`[data-testid="vault-item"][data-folder-id="${folderId}"]`)).toBeVisible({
    timeout: 20000,
  });
}

export async function uploadFile(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<void> {
  await page.getByTestId("file-input").setInputFiles({ name, mimeType, buffer });
  await expect(page.locator('[data-testid="file-item"]', { hasText: name })).toBeVisible({
    timeout: 20000,
  });
}

/** Downloads a file whose name is already visible in the file list and
 * returns its bytes, for a byte-identical comparison against what was
 * uploaded. Retries the click: right after a share/upload, the first
 * download attempt can race the recipient's megolm-session delivery and
 * fail to decrypt even though the file is listed — a real async-settling
 * window, not something to paper over with a fixed sleep. */
export async function downloadFileBytes(page: Page, name: string): Promise<Buffer> {
  const row = page.locator('[data-testid="file-item"]', { hasText: name });
  const button = row.getByTestId("download-file");

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 3000 }),
        button.click(),
      ]);
      const stream = await download.createReadStream();
      if (!stream) throw new Error("download had no stream");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await page.waitForTimeout(500);
    }
  }
}

export async function confirmRecoveryKeySaved(page: Page): Promise<void> {
  await page.getByTestId("copy-recovery-key").click();
  await page.getByTestId("confirm-saved-recovery-key").check();
  await page.getByTestId("recovery-setup-done").click();
  await expect(page.getByTestId("recovery-key-display")).not.toBeVisible({ timeout: 5000 });
}

export async function restoreRecoveryKey(page: Page, key: string): Promise<void> {
  await expect(page.getByTestId("restore-expand")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("restore-expand").click();
  await page.getByTestId("restore-key-input").fill(key.trim());
  await page.getByTestId("restore-submit").click();
  await expect(page.getByTestId("restore-result")).toBeVisible({ timeout: 120_000 });
}

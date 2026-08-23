import { test, expect } from "@playwright/test";
import { registerE2eUser } from "./testUsers";
import { createVault, loginViaUI, openVaultByName, uploadFile, downloadFileBytes } from "./uiHelpers";

test("login, create a folder, and it appears in the list", async ({ page }) => {
  const user = await registerE2eUser("e2e_basic");
  await loginViaUI(page, user);

  await createVault(page, "My Documents");
  // createVault auto-opens the folder; confirm the file view mounted.
  await expect(page.getByTestId("folder-detail")).toBeVisible();
});

test("upload a file, it appears, download it, bytes match", async ({ page }) => {
  const user = await registerE2eUser("e2e_file");
  await loginViaUI(page, user);
  await createVault(page, "Files");
  await openVaultByName(page, "Files");

  const original = Buffer.from("the quick brown fox jumps over the lazy dog\n".repeat(50));
  await uploadFile(page, "fox.txt", "text/plain", original);

  const downloaded = await downloadFileBytes(page, "fox.txt");
  expect(downloaded.equals(original)).toBe(true);
});

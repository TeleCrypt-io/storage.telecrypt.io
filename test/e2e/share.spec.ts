import { test, expect } from "@playwright/test";
import { registerE2eUser } from "./testUsers";
import {
  createVault,
  downloadFileBytes,
  joinFolder,
  loginViaUI,
  openVaultByName,
  uploadFile,
} from "./uiHelpers";

// The core product flow: userA creates a folder and shares it with userB as
// editor (two independent browser contexts — two real, separate crypto
// devices); userB uploads a file; userA sees and downloads userB's file,
// with bytes identical to what userB uploaded. No mocks — real Synapse,
// real E2EE, two real browser sessions.
test("multi-participant share: userA and userB exchange a file", async ({ browser }) => {
  const userA = await registerE2eUser("e2e_share_a");
  const userB = await registerE2eUser("e2e_share_b");

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await loginViaUI(pageA, userA);
    const folderId = await createVault(pageA, "Team Folder");
    await openVaultByName(pageA, "Team Folder");

    await pageA.getByTestId("share-user-id").fill(userB.userId);
    await pageA.getByTestId("share-role").selectOption("editor");
    await pageA.getByTestId("share-submit").click();
    await expect(
      pageA.locator(`[data-testid="member-item"][data-user-id="${userB.userId}"]`),
    ).toBeVisible({ timeout: 20000 });

    // userB: log in (separate context = separate device/crypto store), join
    // the folder by the ID userA's session exposed in the DOM, and upload.
    await loginViaUI(pageB, userB);
    await joinFolder(pageB, folderId, "Team Folder");
    await openVaultByName(pageB, "Team Folder");

    const bobBytes = Buffer.from("hello from userB's editor upload\n".repeat(20));
    await uploadFile(pageB, "from-b.txt", "text/plain", bobBytes);

    // userA: the file userB just uploaded must appear and decrypt.
    await expect(
      pageA.locator('[data-testid="file-item"]', { hasText: "from-b.txt" }),
    ).toBeVisible({ timeout: 20000 });
    const downloadedByA = await downloadFileBytes(pageA, "from-b.txt");
    expect(downloadedByA.equals(bobBytes)).toBe(true);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

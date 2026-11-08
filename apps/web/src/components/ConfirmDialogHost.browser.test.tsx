import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { requestConfirmDialog } from "../confirmDialog";
import { ConfirmDialogHost } from "./ConfirmDialogHost";

it("focuses Confirm so Enter accepts the confirmation", async () => {
  await using screen = await render(<ConfirmDialogHost />);
  const confirmation = requestConfirmDialog("Delete the project?");

  await expect.element(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect(confirmation).resolves.toBe(true);
});

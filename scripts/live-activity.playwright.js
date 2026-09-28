async (page) => {
  await page.goto("http://localhost:5173");
  await page
    .getByRole("button", { name: "Create endpoint", exact: true })
    .first()
    .waitFor();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/endpoints") &&
      response.request().method() === "POST",
  );
  const subscribed = page.waitForResponse((response) =>
    response.url().endsWith("/stream"),
  );
  const snapshot = page.waitForResponse((response) =>
    response.url().endsWith("/events"),
  );
  await page
    .getByRole("button", { name: "Create endpoint", exact: true })
    .first()
    .click();
  const endpoint = await (await created).json();
  let eventReads = 0;
  const countReads = (request) => {
    if (request.url().endsWith(`/api/endpoints/${endpoint.id}/events`))
      eventReads++;
  };
  const trigger = () =>
    page.request.post(endpoint.url, {
      headers: { Authorization: `Bearer ${endpoint.triggerToken}` },
      data: "live activity regression test",
    });
  try {
    if ((await subscribed).status() !== 200)
      throw new Error("SSE did not connect");
    await (await snapshot).finished();
    await page.getByText("No requests recorded yet.").waitFor();
    page.on("request", countReads);
    // An idle connection must not poll the history endpoint.
    await page.waitForTimeout(3500);
    if (eventReads !== 0)
      throw new Error(`Idle stream polled history ${eventReads} times`);
    const start = Date.now();
    if ((await trigger()).status() !== 202) throw new Error("Trigger failed");
    await page
      .locator(".event")
      .filter({ hasText: "POST" })
      .first()
      .waitFor({ timeout: 2000 });
    if (Date.now() - start >= 2000)
      throw new Error("Activity was not delivered immediately");
    // Browser offline / reconnect must catch up without reloading the page.
    await page.context().setOffline(true);
    if ((await trigger()).status() !== 202)
      throw new Error("Offline trigger failed");
    await page.context().setOffline(false);
    await page.waitForFunction(
      () => document.querySelectorAll(".event").length === 2,
      undefined,
      { timeout: 5000 },
    );
  } finally {
    page.off("request", countReads);
    await page.context().setOffline(false);
    await page.request.delete(
      `http://localhost:5173/api/endpoints/${endpoint.id}`,
      {
        headers: { Authorization: `Bearer ${endpoint.managementToken}` },
      },
    );
  }
};

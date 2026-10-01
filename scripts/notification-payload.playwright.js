async function _notificationPayload(page) {
  const origin = await page.evaluate(() => location.origin);
  await page.goto(origin);
  await page.setViewportSize({ width: 390, height: 844 });
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/endpoints") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create endpoint", exact: true })
    .first()
    .click();
  const endpoint = await (await created).json();
  const payload = {
    title: "Deployment complete",
    body: "Production is healthy. All checks passed.",
    deployment: {
      environment: "production",
      services: ["api", "push"],
      checks: { healthy: true },
    },
    arbitrary: {
      html: "<script>window.payloadExecuted = true</script>",
      long: "x".repeat(200),
    },
  };
  try {
    const response = await page.request.post(`${origin}/h/${endpoint.name}`, {
      headers: { Authorization: `Bearer ${endpoint.triggerToken}` },
      data: payload,
    });
    if (response.status() !== 202) throw new Error("Trigger failed");
    const card = page
      .locator(".notification-card")
      .filter({ hasText: payload.title });
    await card.waitFor();
    if ((await card.getAttribute("open")) !== null)
      throw new Error("Should start collapsed");
    await card.locator("summary").click();
    if (
      (await card.locator("pre").innerText()) !==
      JSON.stringify(payload, null, 2)
    )
      throw new Error("Payload lost fields or formatting");
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          window.copiedPayload = text;
        },
      });
    });
    await card
      .getByRole("button", { name: "Copy payload", exact: true })
      .click();
    if (
      (await page.evaluate(() => window.copiedPayload)) !==
      JSON.stringify(payload, null, 2)
    )
      throw new Error("Copy failed");
    if ((await card.getAttribute("open")) === null)
      throw new Error("Copy collapsed accordion");
    await card.locator("summary").focus();
    await page.keyboard.press("Enter");
    if ((await card.getAttribute("open")) !== null)
      throw new Error("Keyboard collapse failed");
    await page.reload();
    await card.waitFor();
    await card.locator("summary").click();
    if (
      (await card.locator("pre").innerText()) !==
      JSON.stringify(payload, null, 2)
    )
      throw new Error("Reload lost payload");
    if (await page.evaluate(() => Boolean(window.payloadExecuted)))
      throw new Error("Payload executed as HTML");
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error("Mobile horizontal overflow");
    await page.screenshot({
      path: "/tmp/sentinel-payload-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: "/tmp/sentinel-payload-desktop.png",
      fullPage: true,
    });
    console.log(
      "PASS: title/body, accordion, copy, keyboard, reload, HTML escaping, mobile layout",
    );
  } finally {
    await page.request.delete(`${origin}/api/endpoints/${endpoint.id}`, {
      headers: { Authorization: `Bearer ${endpoint.managementToken}` },
    });
  }
}

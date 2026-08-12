import type { Hono } from "hono";
import type { HostedIntegrationCatalog } from "@openacme/hosted-integrations";

export function registerHostedIntegrationRoutes(
  app: Hono,
  catalog: HostedIntegrationCatalog,
): void {
  app.get("/api/hosted-integrations/families", async (c) => {
    const families = await catalog.listFamilies();
    return c.json({ families });
  });

  app.get("/api/hosted-integrations/families/:family/tools", async (c) => {
    const family = await catalog.getFamily(c.req.param("family"));
    if (!family) return c.json({ error: "not_found" }, 404);
    return c.json({ tools: family.manifest.tools });
  });

  app.get("/api/hosted-integrations/families/:family", async (c) => {
    const family = await catalog.getFamily(c.req.param("family"));
    if (!family) return c.json({ error: "not_found" }, 404);
    return c.json({ family });
  });
}

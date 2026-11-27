import { getStore } from "@netlify/blobs";
import { handle } from "../lib/core.mjs";

export default async (req) => {
  const store = getStore({ name: "workmgl", consistency: "strong" });
  const env = {
    ADMIN_EMAIL: Netlify.env.get("ADMIN_EMAIL"),
    ADMIN_PASSWORD: Netlify.env.get("ADMIN_PASSWORD"),
  };
  return handle(req, { store, env });
};

export const config = { path: ["/api", "/api/*"] };

import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/auth/"],
    },
    sitemap: "https://www.herzies.app/sitemap.xml",
  };
}

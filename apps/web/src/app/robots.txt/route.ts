import { loadEnv } from "@ecom/config";
import { renderRobots } from "@/lib/seo-files";

export const dynamic = "force-dynamic";

/** robots.txt: zonele private blocate, sitemap-ul indicat; adresa vine din `APP_URL`. */
export async function GET(): Promise<Response> {
  return new Response(renderRobots(loadEnv().APP_URL), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600",
    },
  });
}

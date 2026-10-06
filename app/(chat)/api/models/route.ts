import { getAllCapabilities } from "@/lib/ai/available-models";

/**
 * The app's only model, DZD Learn AI, and what it can do. The models behind
 * it are chosen on the server and are not listed here.
 */
export function GET() {
  return Response.json(
    { capabilities: getAllCapabilities(), extraModels: [] },
    {
      headers: {
        "Cache-Control":
          "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
      },
    }
  );
}

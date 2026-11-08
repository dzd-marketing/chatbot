import { getAllCapabilities } from "@/lib/ai/available-models";

/**
 * The capabilities of the three branded TheStudent AI choices. Provider and
 * underlying model identities remain server-side.
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

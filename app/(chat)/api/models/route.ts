import { getAllCapabilities } from "@/lib/ai/available-models";
import { getAllGatewayModels, isDemo } from "@/lib/ai/models";
import { getNvidiaModels } from "@/lib/ai/nvidia";

export async function GET() {
  // NVIDIA's model list can change, so browsers re-check hourly.
  const headers = {
    "Cache-Control":
      "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
  };

  const [curatedCapabilities, extraModels] = await Promise.all([
    getAllCapabilities(),
    getNvidiaModels(),
  ]);

  if (isDemo) {
    const models = await getAllGatewayModels();
    const capabilities = Object.fromEntries(
      models.map((m) => [m.id, curatedCapabilities[m.id] ?? m.capabilities])
    );

    return Response.json({ capabilities, models }, { headers });
  }

  // extraModels: selectable models discovered at runtime (NVIDIA).
  return Response.json(
    { capabilities: curatedCapabilities, extraModels },
    { headers }
  );
}

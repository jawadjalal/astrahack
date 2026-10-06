import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { json, preflight } from "@/server/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

// Direct-to-Blob uploads for files over the ~4.5MB function body limit (screen recordings).
//   import { upload } from "@vercel/blob/client";
//   const { url } = await upload(`uploads/${name}`, file, { access: "public", handleUploadUrl: `${CANVAS_URL}/api/upload/token` });
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as HandleUploadBody;
    const res = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["image/*", "video/mp4", "video/webm", "video/quicktime"],
        maximumSizeInBytes: 500 * 1024 * 1024,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {},
    });
    return json(res);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 400);
  }
}

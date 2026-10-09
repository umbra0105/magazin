import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/services";

export const dynamic = "force-dynamic";

// Instanța depinde de setări, deci se rezolvă la fiecare cerere (e în cache după prima).
export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(await getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(await getAuth()).POST(request);
}
